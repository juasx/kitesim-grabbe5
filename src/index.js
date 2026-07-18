import { DurableObject } from "cloudflare:workers";

// Durable Object 部分（不变）
export class GrabberDO extends DurableObject {
  // ... (保持你上一个版本的完整 DO 代码)
  // 为了简洁，这里省略，实际用你已有的完整 DO
}

// 主 Worker 和 HTML
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

    if (url.pathname.startsWith("/grab/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 3) {
        const email = decodeURIComponent(parts[1]);
        const action = parts[2];

        const id = env.GRABBER.idFromName(email);
        const stub = env.GRABBER.get(id);

        const newUrl = new URL(request.url);
        newUrl.pathname = "/" + action;
        return stub.fetch(new Request(newUrl, request));
      }
      return json({ error: "path error" }, 400);
    }

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
        <div class="nav-title">Kite Grabber（多账号后台）</div>
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
  let statusMap = {};

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
      const isPaused = !!st.isPaused;
      const lastPhone = st.lastPhone;

      let statusHtml = '';
      if (isPaused) {
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
      div.innerHTML = '<div class="acc-info" onclick="viewLogs(\\'' + acc.email + '\\')" style="cursor:pointer;">' +
        '<div class="acc-email">' + acc.email + '</div>' +
        '<div class="acc-meta">' + statusHtml + '</div></div>' +
        '<div class="acc-actions">' +
        '<button class="btn small" ' + (isRunning || isPaused ? 'disabled' : '') + ' onclick="startOne(\\'' + acc.email + '\\')">开始</button>' +
        '<button class="btn secondary small" onclick="checkToken(\\'' + acc.email + '\\')">检查</button>' +
        '<button class="btn secondary small" onclick="stopOne(\\'' + acc.email + '\\')">停止</button>' +
        '<button class="btn secondary small" style="color:#c8102e;" onclick="removeAccount(' + index + ')">删</button>' +
        '</div>';
      container.appendChild(div);
    });
  }

  async function checkToken(email) {
    const acc = accounts.find(a => a.email === email);
    if (!acc) return alert('账号不存在');

    const btn = event.target;
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/grab/' + encodeURIComponent(email) + '/status');
      const data = await res.json();

      if (data.isRunning || data.isPaused || data.lastPhone) {
        alert('✅ Token 有效');
      } else {
        alert('❌ Token 可能已失效，请重新登录');
      }
    } catch (e) {
      alert('检查失败: ' + e.message);
    }

    if (btn) btn.disabled = false;
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
