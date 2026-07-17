import { DurableObject } from "cloudflare:workers";

// ==================== Durable Object：每个账号独立实例 ====================
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

    // 保留历史成功记录
    const old = (await this.ctx.storage.get("state")) || {};
    const history = old.history || [];

    const state = {
      email,
      token,
      patterns: patterns || ["aaab", "abbb", "aaaa", "abab", "abba"],
      isRunning: true,
      totalScanned: old.totalScanned || 0,
      lastPhone: old.lastPhone || null,
      lastOrderNo: old.lastOrderNo || null,
      pauseUntil: 0,
      history,
      startedAt: Date.now(),
    };

    await this.ctx.storage.put("state", state);
    await this.addLog(`开始抢号：${email} | 匹配类：${state.patterns.join(",")}`);

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
    const now = Date.now();
    const pauseUntil = state.pauseUntil || 0;
    const isPaused = pauseUntil > now;
    return json({
      isRunning: !!state.isRunning,
      isPaused,
      pauseUntil,
      email: state.email || null,
      totalScanned: state.totalScanned || 0,
      lastPhone: state.lastPhone || null,
      lastOrderNo: state.lastOrderNo || null,
      history: state.history || [],
      logs: logs.slice(-40),
    });
  }

  async alarm() {
    const state = await this.ctx.storage.get("state");
    if (!state || !state.isRunning) return;

    const now = Date.now();
    // 还在暂停期
    if (state.pauseUntil && state.pauseUntil > now) {
      const leftMin = Math.ceil((state.pauseUntil - now) / 60000);
      // 每分钟打一次日志提示
      if (!state.lastPauseLog || now - state.lastPauseLog > 55000) {
        await this.addLog(`暂停中，约 ${leftMin} 分钟后恢复抢号...`);
        state.lastPauseLog = now;
        await this.ctx.storage.put("state", state);
      }
      // 精确约到暂停结束
      await this.ctx.storage.setAlarm(Math.min(state.pauseUntil, now + 60000));
      return;
    }

    // 暂停刚结束
    if (state.pauseUntil && state.pauseUntil <= now) {
      state.pauseUntil = 0;
      await this.ctx.storage.put("state", state);
      await this.addLog("暂停结束，恢复抢号");
    }

    try {
      await this.pollOnce();
    } catch (e) {
      await this.addLog("轮询出错: " + e.message);
    }

    const latest = await this.ctx.storage.get("state");
    if (latest && latest.isRunning) {
      // 如果刚成功进入暂停，约到暂停结束；否则 10 秒后
      if (latest.pauseUntil && latest.pauseUntil > Date.now()) {
        await this.ctx.storage.setAlarm(Math.min(latest.pauseUntil, Date.now() + 60000));
      } else {
        await this.ctx.storage.setAlarm(Date.now() + 10000);
      }
    }
  }

  async pollOnce() {
    const state = await this.ctx.storage.get("state");
    if (!state || !state.isRunning) return;

    const { token, email, patterns } = state;

    const hasPaid = await this.checkHasPaidNumber(token);
    if (hasPaid) {
      // 已有待支付订单，暂停 30 分钟再试（给用户时间处理订单）
      state.pauseUntil = Date.now() + 30 * 60 * 1000;
      await this.ctx.storage.put("state", state);
      await this.addLog(`${email} 已有未支付订单，暂停 30 分钟后再试`);
      return;
    }

    const numRes = await this.getNewNumber(token);
    state.totalScanned = (state.totalScanned || 0) + 1;
    await this.ctx.storage.put("state", state);

    if (numRes.code !== 200 || !Array.isArray(numRes.data) || numRes.data.length === 0) {
      await this.addLog(`第 ${state.totalScanned} 次 | 获取号码失败`);
      return;
    }

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

    const buyRes = await this.buyNumber(matchedPhone, token);
    if (buyRes.code !== 200 || !buyRes.data?.orderNo) {
      await this.addLog(`占号失败（${buyRes.message || "未知"}），继续轮询...`);
      return;
    }

    // 返回订单号 = 成功 → 记录历史，暂停 30 分钟后自动恢复
    state.lastPhone = matchedPhone;
    state.lastOrderNo = buyRes.data.orderNo;
    state.pauseUntil = Date.now() + 30 * 60 * 1000; // 30 分钟
    state.history = state.history || [];
    state.history.push({
      phone: matchedPhone,
      orderNo: buyRes.data.orderNo,
      class: matchedClass,
      time: new Date().toLocaleString("zh-CN", { hour12: false }),
    });
    // 只保留最近 20 条历史
    if (state.history.length > 20) state.history = state.history.slice(-20);
    await this.ctx.storage.put("state", state);

    await this.addLog(`【成功】${matchedClass}类 ${matchedPhone} | 订单号 ${buyRes.data.orderNo}`);
    await this.addLog(`已暂停 30 分钟，之后自动恢复抢号`);

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
    if (logs.length > 80) logs.splice(0, logs.length - 80);
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

    // /grab/<email>/start  /grab/<email>/stop  /grab/<email>/status
    if (url.pathname.startsWith("/grab/")) {
      const parts = url.pathname.split("/").filter(Boolean); // ["grab", "email@xx.com", "start"]
      if (parts.length >= 3) {
        const email = decodeURIComponent(parts[1]);
        const action = parts[2]; // start / stop / status / clear-logs

        const id = env.GRABBER.idFromName(email); // 每个邮箱独立实例
        const stub = env.GRABBER.get(id);

        const newUrl = new URL(request.url);
        newUrl.pathname = "/" + action;
        return stub.fetch(new Request(newUrl, request));
      }
      return json({ error: "path error, use /grab/<email>/start|stop|status" }, 400);
    }

    // 原有代理
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

// ==================== 前端（支持多账号并行） ====================
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Kite Grabber（多账号后台）</title>
  <style>
    body { font-family: system-ui; background: #f5f5f7; margin: 0; padding: 16px; }
    .container { max-width: 720px; margin: 0 auto; }
    .card { background: white; border-radius: 16px; padding: 18px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .btn { background: #c8102e; color: white; border: none; padding: 10px 14px; border-radius: 10px; font-size: 14px; cursor: pointer; }
    .btn.secondary { background: #f0f0f3; color: #333; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.small { padding: 6px 10px; font-size: 12px; }
    input, select { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 12px; margin-bottom: 12px; font-size: 15px; box-sizing: border-box; }
    .log { background: #f8f9fa; padding: 12px; border-radius: 12px; max-height: 280px; overflow-y: auto; font-size: 12px; line-height: 1.5; }
    .log-item { padding: 4px 0; border-bottom: 1px solid #eee; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 20px; display: inline-block; }
    .status.running { background: #d4edda; color: #155724; }
    .status.stopped { background: #f8d7da; color: #721c24; }
    .status.success { background: #cce5ff; color: #004085; }
    .page { display: none; }
    .page.active { display: block; }
    .nav { display: flex; align-items: center; margin-bottom: 16px; }
    .nav-title { font-size: 20px; font-weight: 700; flex: 1; }
    .acc-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; gap: 8px; }
    .acc-info { flex: 1; min-width: 0; }
    .acc-email { font-weight: 600; font-size: 14px; word-break: break-all; }
    .acc-meta { font-size: 12px; color: #666; margin-top: 4px; }
    .acc-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .tip { font-size: 13px; color: #666; margin-top: 8px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="page active" id="pageMain">
      <div class="nav">
        <div class="nav-title">Kite Grabber（多账号）</div>
        <button class="btn secondary" style="width:auto;padding:8px 14px;" onclick="goAddAccount()">添加账号</button>
      </div>

      <div class="card">
        <h3 style="margin:0 0 8px 0;">账号列表（可同时开多个）</h3>
        <div class="tip">每个账号独立后台跑，互不影响。点「开始」后可关闭浏览器。</div>
        <div id="accountList" style="margin-top:12px;"></div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 8px 0;">全局设置</h3>
        <label>要匹配的类（逗号分隔）</label>
        <input id="patterns" value="aaab, abbb, aaaa, abab, abba">
        <div class="tip">只购买 0.3 季包</div>
        <div id="historyBox" style="margin-top:12px;font-size:13px;"></div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 8px 0;">日志（当前选中账号）</h3>
        <div id="currentEmail" style="font-size:13px;color:#666;margin-bottom:8px;"></div>
        <div id="log" class="log"></div>
        <div style="display:flex; gap:10px; margin-top:10px;">
          <button class="btn secondary" onclick="refreshAll()" style="flex:1;">刷新全部状态</button>
          <button class="btn secondary" onclick="clearCurrentLogs()" style="flex:1;">清空当前日志</button>
        </div>
      </div>
    </div>

    <div class="page" id="pageAddAccount">
      <div class="nav">
        <button class="btn secondary" style="width:auto;padding:8px 14px;" onclick="goMain()">返回</button>
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
        <button class="btn" style="width:100%;" onclick="doLogin()">登录并添加</button>
        <div id="loginMsg" style="margin-top:10px; text-align:center; font-size:14px;"></div>
      </div>
    </div>
  </div>

<script>
  let accounts = JSON.parse(localStorage.getItem('grabber_accounts') || '[]');
  let captchaKey = '';
  let currentViewEmail = null;
  let statusTimer = null;
  let statusMap = {}; // email -> status

  function saveAccounts() { localStorage.setItem('grabber_accounts', JSON.stringify(accounts)); }

  function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function goMain() {
    showPage('pageMain');
    renderAccounts();
    refreshAll();
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
      container.innerHTML = '<div style="color:#888;padding:12px 0;">还没有账号</div>';
      return;
    }

    accounts.forEach((acc, index) => {
      const st = statusMap[acc.email] || {};
      const isRunning = !!st.isRunning;
      const lastPhone = st.lastPhone;

      let statusHtml = '';
      if (st.isPaused) {
        const left = st.pauseUntil ? Math.ceil((st.pauseUntil - Date.now()) / 60000) : 30;
        statusHtml = '<span class="status success">暂停中 · ' + left + '分钟后恢复</span>';
      } else if (lastPhone && !isRunning) {
        statusHtml = '<span class="status success">已占到 ' + lastPhone + '</span>';
      } else if (isRunning) {
        statusHtml = '<span class="status running">运行中 · ' + (st.totalScanned || 0) + '次</span>';
      } else {
        statusHtml = '<span class="status stopped">已停止</span>';
      }

      const div = document.createElement('div');
      div.className = 'acc-row';
      div.innerHTML = \`
        <div class="acc-info" onclick="viewLogs('\${acc.email}')" style="cursor:pointer;">
          <div class="acc-email">\${acc.email}</div>
          <div class="acc-meta">\${statusHtml}</div>
        </div>
        <div class="acc-actions">
          <button class="btn small" \${isRunning ? 'disabled' : ''} onclick="startOne('\${acc.email}')">开始</button>
          <button class="btn secondary small" onclick="stopOne('\${acc.email}')">停止</button>
          <button class="btn secondary small" style="color:#c8102e;" onclick="removeAccount(\${index})">删</button>
        </div>
      \`;
      container.appendChild(div);
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
    const email = accounts[index].email;
    // 先尝试停止
    fetch('/grab/' + encodeURIComponent(email) + '/stop', { method: 'POST' }).catch(() => {});
    accounts.splice(index, 1);
    saveAccounts();
    delete statusMap[email];
    renderAccounts();
  }

  async function startOne(email) {
    const acc = accounts.find(a => a.email === email);
    if (!acc) return;

    const patterns = document.getElementById('patterns').value
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    try {
      const res = await fetch('/grab/' + encodeURIComponent(email) + '/start', {
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
        viewLogs(email);
        refreshAll();
      } else {
        alert(json.error || '启动失败');
      }
    } catch (e) {
      alert('请求失败: ' + e.message);
    }
  }

  async function stopOne(email) {
    try {
      await fetch('/grab/' + encodeURIComponent(email) + '/stop', { method: 'POST' });
      refreshAll();
    } catch (e) {
      alert('停止失败');
    }
  }

  async function viewLogs(email) {
    currentViewEmail = email;
    document.getElementById('currentEmail').textContent = '当前查看：' + email;
    await refreshOne(email);
  }

  async function refreshOne(email) {
    try {
      const res = await fetch('/grab/' + encodeURIComponent(email) + '/status');
      const data = await res.json();
      statusMap[email] = data;

      if (currentViewEmail === email) {
        const logEl = document.getElementById('log');
        if (data.logs && data.logs.length) {
          logEl.innerHTML = data.logs.slice().reverse().map(function(l) {
            return '<div class="log-item">' + l + '</div>';
          }).join('');
        } else {
          logEl.innerHTML = '<div style="color:#888;">暂无日志</div>';
        }
        renderHistory(data.history || []);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function refreshAll() {
    for (const acc of accounts) {
      await refreshOne(acc.email);
    }
    renderAccounts();
  }

  async function clearCurrentLogs() {
    if (!currentViewEmail) return;
    await fetch('/grab/' + encodeURIComponent(currentViewEmail) + '/clear-logs', { method: 'POST' });
    document.getElementById('log').innerHTML = '';
  }

  function renderHistory(history) {
    const box = document.getElementById('historyBox');
    if (!box) return;
    if (!history || history.length === 0) {
      box.innerHTML = '<div style="color:#888;">暂无历史占号记录</div>';
      return;
    }
    let html = '<div style="font-weight:600;margin-bottom:6px;">历史占成功号码：</div>';
    history.slice().reverse().forEach(function(h) {
      html += '<div style="padding:4px 0;border-bottom:1px solid #eee;">' +
        (h.class || '') + ' ' + h.phone +
        ' <span style="color:#888;font-size:11px;">' + (h.time || '') + '</span></div>';
    });
    box.innerHTML = html;
  }

  function startAutoRefresh() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(refreshAll, 6000);
  }

  function init() {
    renderAccounts();
    refreshAll();
    startAutoRefresh();
  }

  init();
</script>
</body>
</html>`;
