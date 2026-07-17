import { DurableObject } from "cloudflare:workers";

// ==================== Durable Object：真正后台抢号 ====================
export class GrabberDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      if (path === "/start" && request.method === "POST") {
        const body = await request.json();
        return await this.startGrab(body);
      }
      if (path === "/stop" && request.method === "POST") {
        return await this.stopGrab();
      }
      if (path === "/status") {
        return await this.getStatus();
      }
      if (path === "/logs") {
        return await this.getLogs();
      }
      if (path === "/clear-logs" && request.method === "POST") {
        await this.ctx.storage.put("logs", []);
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  async startGrab({ email, token, patterns }) {
    if (!email || !token) {
      return json({ error: "缺少 email 或 token" }, 400);
    }

    const state = {
      email,
      token,
      patterns: patterns || ["aaab", "abbb", "aaaa", "abab", "abba"],
      isRunning: true,
      totalScanned: 0,
      lastPhone: null,
      lastOrderNo: null,
      startedAt: Date.now(),
    };

    await this.ctx.storage.put("state", state);
    await this.addLog(`开始抢号：${email} | 匹配类：${state.patterns.join(",")}`);

    // 立刻跑一次 + 设置 10 秒后的闹钟
    await this.pollOnce();
    await this.ctx.storage.setAlarm(Date.now() + 10000);

    return json({ ok: true, message: "已启动后台抢号" });
  }

  async stopGrab() {
    const state = (await this.ctx.storage.get("state")) || {};
    state.isRunning = false;
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.deleteAlarm();
    await this.addLog("已停止抢号");
    return json({ ok: true });
  }

  async getStatus() {
    const state = (await this.ctx.storage.get("state")) || { isRunning: false };
    const logs = (await this.ctx.storage.get("logs")) || [];
    return json({
      isRunning: !!state.isRunning,
      email: state.email || null,
      totalScanned: state.totalScanned || 0,
      lastPhone: state.lastPhone || null,
      lastOrderNo: state.lastOrderNo || null,
      logs: logs.slice(-50),
    });
  }

  async getLogs() {
    const logs = (await this.ctx.storage.get("logs")) || [];
    return json({ logs });
  }

  // 每 10 秒自动执行
  async alarm() {
    const state = await this.ctx.storage.get("state");
    if (!state || !state.isRunning) return;

    try {
      await this.pollOnce();
    } catch (e) {
      await this.addLog("轮询出错: " + e.message);
    }

    // 还在运行就继续约下一次
    const latest = await this.ctx.storage.get("state");
    if (latest && latest.isRunning) {
      await this.ctx.storage.setAlarm(Date.now() + 10000);
    }
  }

  async pollOnce() {
    const state = await this.ctx.storage.get("state");
    if (!state || !state.isRunning) return;

    const { token, email, patterns } = state;

    // 1. 检查是否已有未支付订单
    const hasPaid = await this.checkHasPaidNumber(token);
    if (hasPaid) {
      await this.addLog(`${email} 已有未支付CA号，自动锁定并停止`);
      state.isRunning = false;
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // 2. 拉号码
    const numRes = await this.getNewNumber(token);
    state.totalScanned = (state.totalScanned || 0) + 1;
    await this.ctx.storage.put("state", state);

    if (numRes.code !== 200 || !Array.isArray(numRes.data) || numRes.data.length === 0) {
      await this.addLog(`第 ${state.totalScanned} 次 | 获取号码失败`);
      return;
    }

    // 3. 找匹配号码
    let matchedPhone = null;
    let matchedClass = "";

    for (const item of numRes.data) {
      if (!item.phoneNumber || item.buyPrice !== 0.3) continue;
      const last4 = item.phoneNumber.slice(-4);
      for (const pat of patterns) {
        if (this.matchesPattern(last4, pat)) {
          matchedPhone = item.phoneNumber;
          matchedClass = pat;
          break;
        }
      }
      if (matchedPhone) break;
    }

    if (!matchedPhone) {
      await this.addLog(`第 ${state.totalScanned} 次 | 无符合条件号码`);
      return;
    }

    await this.addLog(`发现 ${matchedClass}类 号码 ${matchedPhone}（0.3季包），开始占号...`);

    // 4. 占号
    const buyRes = await this.buyNumber(matchedPhone, token);
    if (buyRes.code !== 200 || !buyRes.data?.orderNo) {
      await this.addLog(`占号失败（${buyRes.message || "未知"}），继续轮询...`);
      return;
    }

    // ★ 返回订单号 = 成功，立刻锁定
    state.lastPhone = matchedPhone;
    state.lastOrderNo = buyRes.data.orderNo;
    state.isRunning = false;
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.deleteAlarm();

    await this.addLog(`【成功锁定】${matchedClass}类 ${matchedPhone} | 订单号 ${buyRes.data.orderNo}`);

    // 尝试确认支付（余额不足也不影响）
    try {
      const payRes = await this.confirmPay(buyRes.data.orderNo, token);
      if (payRes.code === 200) {
        await this.addLog("确认支付成功");
      } else {
        await this.addLog(`确认支付返回（${payRes.message || "未知"}），订单已生成`);
      }
    } catch (e) {
      await this.addLog("确认支付异常，但订单已生成");
    }
  }

  matchesPattern(last4, pattern) {
    if (!last4 || last4.length !== 4) return false;
    const [a, b, c, d] = last4.split("");
    if (pattern === "aaaa") return a === b && b === c && c === d;
    if (pattern === "aaab") return a === b && b === c && c !== d;
    if (pattern === "abbb") return a !== b && b === c && c === d;
    if (pattern === "abab") return a === c && b === d && a !== b;
    if (pattern === "abba") return a === d && b === c && a !== b;
    return false;
  }

  async checkHasPaidNumber(token) {
    try {
      const res = await fetch(
        "https://api.kitesim.co/userPhonePurchase/getOrderPage?page=1&size=10&status=1&phone=",
        {
          headers: {
            token,
            Origin: "https://h5.kitesim.co",
            Referer: "https://h5.kitesim.co/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
          },
        }
      );
      const data = await res.json();
      return data.data?.records?.length > 0;
    } catch (e) {
      return false;
    }
  }

  async getNewNumber(token) {
    const res = await fetch("https://api.kitesim.co/countryCode/getPhoneNumber/CA", {
      headers: {
        token,
        Origin: "https://h5.kitesim.co",
        Referer: "https://h5.kitesim.co/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      },
    });
    return await res.json();
  }

  async buyNumber(phoneNumber, token) {
    try {
      const res = await fetch("https://api.kitesim.co/userPhonePurchase/buyPhoneNumberOrder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          token,
          Origin: "https://h5.kitesim.co",
          Referer: "https://h5.kitesim.co/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          autoRenew: 0,
          countryCode: "CA",
          couponId: null,
          couponType: null,
          isSelected: 0,
          packageId: "1958014808238002177",
          phoneNumber,
          serviceId: "",
          type: 1,
        }),
      });
      return await res.json();
    } catch (e) {
      return { code: 0, message: e.message };
    }
  }

  async confirmPay(orderNo, token) {
    try {
      const res = await fetch("https://api.kitesim.co/userPhonePurchase/confirmPay", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          token,
          Origin: "https://h5.kitesim.co",
          Referer: "https://h5.kitesim.co/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          paymentMethod: 1,
          payChannel: "1",
          orderNo,
        }),
      });
      return await res.json();
    } catch (e) {
      return { code: 0, message: e.message };
    }
  }

  async addLog(text) {
    const logs = (await this.ctx.storage.get("logs")) || [];
    const time = new Date().toLocaleString("zh-CN", { hour12: false });
    logs.push(`[${time}] ${text}`);
    if (logs.length > 100) logs.splice(0, logs.length - 100);
    await this.ctx.storage.put("logs", logs);
  }
}

// ==================== 主 Worker ====================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, token",
        },
      });
    }

    // 后台抢号接口 → Durable Object
    if (url.pathname.startsWith("/grab/")) {
      const id = env.GRABBER.idFromName("main");
      const stub = env.GRABBER.get(id);
      const newUrl = new URL(request.url);
      newUrl.pathname = url.pathname.replace(/^\/grab/, "") || "/";
      return stub.fetch(new Request(newUrl, request));
    }

    // 原有代理（登录、验证码等）
    if (url.pathname.startsWith("/api/")) {
      const targetPath = url.pathname.replace(/^\/api/, "") + url.search;
      const target = "https://api.kitesim.co" + targetPath;
      const headers = {
        Origin: "https://h5.kitesim.co",
        Referer: "https://h5.kitesim.co/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      };
      const clientToken = request.headers.get("token");
      if (clientToken) headers["token"] = clientToken;
      let body = null;
      if (request.method === "POST" || request.method === "PUT") {
        body = await request.text();
        headers["Content-Type"] = "application/json";
      }
      const resp = await fetch(target, { method: request.method, headers, body });
      const data = await resp.text();
      return new Response(data, {
        status: resp.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ==================== 前端页面 ====================
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Kite Grabber（后台版）</title>
  <style>
    body { font-family: system-ui; background: #f5f5f7; margin: 0; padding: 16px; }
    .container { max-width: 720px; margin: 0 auto; }
    .card { background: white; border-radius: 16px; padding: 18px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .btn { background: #c8102e; color: white; border: none; padding: 12px 18px; border-radius: 12px; font-size: 15px; cursor: pointer; width: 100%; }
    .btn.secondary { background: #f0f0f3; color: #333; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    input, select { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 12px; margin-bottom: 12px; font-size: 15px; box-sizing: border-box; }
    .log { background: #f8f9fa; padding: 12px; border-radius: 12px; max-height: 360px; overflow-y: auto; font-size: 13px; line-height: 1.5; }
    .log-item { padding: 5px 0; border-bottom: 1px solid #eee; }
    .status { font-size: 13px; padding: 6px 12px; border-radius: 20px; display: inline-block; }
    .status.running { background: #d4edda; color: #155724; }
    .status.stopped { background: #f8d7da; color: #721c24; }
    .page { display: none; }
    .page.active { display: block; }
    .nav { display: flex; align-items: center; margin-bottom: 16px; }
    .nav-title { font-size: 20px; font-weight: 700; flex: 1; }
    .tip { font-size: 13px; color: #666; margin-top: 8px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="page active" id="pageMain">
      <div class="nav">
        <div class="nav-title">Kite Grabber（后台版）</div>
        <button class="btn secondary" style="width:auto;padding:8px 16px;" onclick="goAddAccount()">添加账号</button>
      </div>

      <div class="card">
        <h3 style="margin:0 0 12px 0;">已添加账号</h3>
        <div id="accountList"></div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 12px 0;">后台抢号</h3>
        <div>
          <label>选择账号</label>
          <select id="selectedAccount"></select>
        </div>
        <div style="margin-top:12px;">
          <label>要匹配的类（逗号分隔）</label>
          <input id="patterns" value="aaab, abbb, aaaa, abab, abba">
        </div>
        <div class="tip">只购买 0.3 季包。点击「开始后台抢号」后，关闭浏览器/手机锁屏也会继续跑。</div>
        <div style="margin-top:16px; display:flex; gap:10px;">
          <button class="btn" id="btnStart" onclick="startGrab()">开始后台抢号</button>
          <button class="btn secondary" id="btnStop" onclick="stopGrab()">停止</button>
        </div>
        <div id="grabStatus" style="margin-top:12px;"></div>
        <div id="lastResult" style="margin-top:8px;font-size:14px;color:#333;"></div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 8px 0;">抢号日志 <span id="scanCount" style="font-size:13px;color:#666;"></span></h3>
        <div id="log" class="log"></div>
        <div style="display:flex; gap:10px; margin-top:10px;">
          <button class="btn secondary" onclick="refreshStatus()" style="flex:1;">刷新状态</button>
          <button class="btn secondary" onclick="clearLogs()" style="flex:1;">清空日志</button>
        </div>
      </div>
    </div>

    <div class="page" id="pageAddAccount">
      <div class="nav">
        <button class="btn secondary" style="width:auto;padding:8px 16px;" onclick="goMain()">返回</button>
        <div class="nav-title" style="text-align:center;">添加账号</div>
        <div style="width:60px"></div>
      </div>
      <div class="card">
        <input id="email" type="email" placeholder="邮箱">
        <input id="pass" type="password" placeholder="密码">
        <div style="display:flex; gap:10px; align-items:center; margin-bottom:12px;">
          <input id="captchaCode" placeholder="验证码" style="flex:1; margin-bottom:0;">
          <img id="captchaImg" onclick="loadCaptcha()" style="height:46px; width:110px; border-radius:10px; cursor:pointer;">
        </div>
        <button class="btn" onclick="doLogin()">登录并添加</button>
        <div id="loginMsg" style="margin-top:10px; text-align:center; font-size:14px;"></div>
      </div>
    </div>
  </div>

<script>
  let accounts = JSON.parse(localStorage.getItem('grabber_accounts') || '[]');
  let captchaKey = '';
  let statusTimer = null;

  function saveAccounts() { localStorage.setItem('grabber_accounts', JSON.stringify(accounts)); }

  function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function goMain() {
    showPage('pageMain');
    renderAccounts();
    refreshStatus();
  }

  function goAddAccount() {
    showPage('pageAddAccount');
    loadCaptcha();
    document.getElementById('loginMsg').textContent = '';
  }

  function renderAccounts() {
    const container = document.getElementById('accountList');
    container.innerHTML = '';
    if (accounts.length === 0) {
      container.innerHTML = '<div style="color:#888;">还没有账号，点击右上角“添加账号”</div>';
      return;
    }
    accounts.forEach((acc, index) => {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #eee;';
      div.innerHTML = \`
        <div><strong>\${acc.email}</strong></div>
        <div>
          <button onclick="removeAccount(\${index})" style="padding:4px 10px;font-size:12px;color:#c8102e;">删除</button>
        </div>
      \`;
      container.appendChild(div);
    });
    updateAccountSelect();
  }

  function updateAccountSelect() {
    const select = document.getElementById('selectedAccount');
    select.innerHTML = '';
    accounts.forEach((acc, index) => {
      const opt = document.createElement('option');
      opt.value = index;
      opt.textContent = acc.email;
      select.appendChild(opt);
    });
  }

  async function loadCaptcha() {
    try {
      const res = await fetch('/api/index/captcha-image-base64');
      const json = await res.json();
      if (json.captchaKey) {
        captchaKey = json.captchaKey;
        document.getElementById('captchaImg').src = 'data:image/png;base64,' + json.captchaImageBase64;
      }
    } catch (e) {}
  }

  async function doLogin() {
    const email = document.getElementById('email').value.trim();
    const pass = document.getElementById('pass').value;
    const code = document.getElementById('captchaCode').value.trim();
    const msg = document.getElementById('loginMsg');
    if (!email || !pass || !code) {
      msg.textContent = '请填写完整';
      msg.style.color = '#c8102e';
      return;
    }
    msg.textContent = '登录中...';
    msg.style.color = '#333';
    try {
      const res = await fetch('/api/index/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pass, captchaCode: code, captchaKey })
      });
      const json = await res.json();
      if (json.code === 200 && json.data) {
        if (accounts.some(a => a.email === email)) {
          msg.textContent = '该账号已存在';
          msg.style.color = '#c8102e';
          return;
        }
        accounts.push({ email, token: json.data });
        saveAccounts();
        msg.textContent = '添加成功！';
        msg.style.color = '#34c759';
        setTimeout(() => goMain(), 600);
      } else {
        msg.textContent = json.message || '登录失败';
        msg.style.color = '#c8102e';
        loadCaptcha();
      }
    } catch (e) {
      msg.textContent = '网络错误';
      msg.style.color = '#c8102e';
    }
  }

  function removeAccount(index) {
    if (!confirm('确定删除？')) return;
    accounts.splice(index, 1);
    saveAccounts();
    renderAccounts();
  }

  async function startGrab() {
    const select = document.getElementById('selectedAccount');
    if (!select.value) { alert('请先选择账号'); return; }
    const acc = accounts[parseInt(select.value)];
    if (!acc) return;

    const patterns = document.getElementById('patterns').value
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    document.getElementById('btnStart').disabled = true;
    try {
      const res = await fetch('/grab/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: acc.email,
          token: acc.token,
          patterns
        })
      });
      const json = await res.json();
      if (json.ok) {
        alert('已启动后台抢号！现在可以关闭浏览器了');
        refreshStatus();
        startAutoRefresh();
      } else {
        alert(json.error || '启动失败');
      }
    } catch (e) {
      alert('请求失败: ' + e.message);
    }
    document.getElementById('btnStart').disabled = false;
  }

  async function stopGrab() {
    try {
      await fetch('/grab/stop', { method: 'POST' });
      refreshStatus();
    } catch (e) {
      alert('停止失败');
    }
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/grab/status');
      const data = await res.json();

      const statusEl = document.getElementById('grabStatus');
      if (data.isRunning) {
        statusEl.innerHTML = '<span class="status running">后台运行中...</span>';
        document.getElementById('btnStart').disabled = true;
      } else {
        statusEl.innerHTML = '<span class="status stopped">已停止</span>';
        document.getElementById('btnStart').disabled = false;
      }

      document.getElementById('scanCount').textContent = data.totalScanned
        ? \`共轮询 \${data.totalScanned} 次\`
        : '';

      if (data.lastPhone) {
        document.getElementById('lastResult').innerHTML =
          \`最近成功：<b>\${data.lastPhone}</b> | 订单号 \${data.lastOrderNo}\`;
      }

      const logEl = document.getElementById('log');
      if (data.logs && data.logs.length) {
        logEl.innerHTML = data.logs.slice().reverse().map(l =>
          \`<div class="log-item">\${l}</div>\`
        ).join('');
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function clearLogs() {
    await fetch('/grab/clear-logs', { method: 'POST' });
    document.getElementById('log').innerHTML = '';
  }

  function startAutoRefresh() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 5000);
  }

  function init() {
    renderAccounts();
    refreshStatus();
    startAutoRefresh();
  }

  init();
</script>
</body>
</html>`;
