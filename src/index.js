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
    if (url.pathname.startsWith("/api/")) {
      const targetPath = url.pathname.replace(/^\/api/, "") + url.search;
      const target = "https://api.kitesim.co" + targetPath;
      const headers = {
        "Origin": "https://h5.kitesim.co",
        "Referer": "https://h5.kitesim.co/",
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
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Kite Grabber</title>
  <style>
    body { font-family: system-ui; background: #f5f5f7; margin: 0; padding: 16px; }
    .container { max-width: 720px; margin: 0 auto; }
    .card { background: white; border-radius: 16px; padding: 18px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .btn { background: #c8102e; color: white; border: none; padding: 12px 18px; border-radius: 12px; font-size: 15px; cursor: pointer; width: 100%; }
    .btn.secondary { background: #f0f0f3; color: #333; }
    input, select { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 12px; margin-bottom: 12px; font-size: 15px; }
    .log { background: #f8f9fa; padding: 12px; border-radius: 12px; max-height: 320px; overflow-y: auto; font-size: 13px; line-height: 1.5; }
    .log-item { padding: 5px 0; border-bottom: 1px solid #eee; }
    .status { font-size: 13px; padding: 6px 12px; border-radius: 20px; display: inline-block; }
    .status.running { background: #d4edda; color: #155724; }
    .status.stopped { background: #f8d7da; color: #721c24; }
    .page { display: none; }
    .page.active { display: block; }
    .nav { display: flex; align-items: center; margin-bottom: 16px; }
    .nav-title { font-size: 20px; font-weight: 700; flex: 1; }
  </style>
</head>
<body>
  <div class="container">
    <!-- 主页 -->
    <div class="page active" id="pageMain">
      <div class="nav">
        <div class="nav-title">Kite Grabber</div>
        <button class="btn secondary" style="width:auto;padding:8px 16px;" onclick="goAddAccount()">添加账号</button>
      </div>
      <div class="card">
        <h3 style="margin:0 0 12px 0;">已添加账号</h3>
        <div id="accountList"></div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 12px 0;">抢号设置</h3>
        <div>
          <label>选择账号</label>
          <select id="selectedAccount"></select>
        </div>
        <div style="margin-top:12px;">
          <label>要匹配的类（aaab, abbb, aaaa, abab, abba）</label>
          <input id="patterns" value="aaab, abbb, aaaa, abab, abba">
        </div>
        <div style="margin-top:8px; font-size:13px; color:#666;">
          只购买季包 0.3 的号码
        </div>
        <div style="margin-top:16px; display:flex; gap:10px;">
          <button class="btn" onclick="startGrab()">开始抢号（每10秒）</button>
          <button class="btn secondary" onclick="stopGrab()">停止</button>
        </div>
        <div id="grabStatus" style="margin-top:12px;"></div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 8px 0;">抢号日志 <span id="scanCount" style="font-size:13px;color:#666;"></span></h3>
        <div id="log" class="log"></div>
        
        <div style="display:flex; gap:10px; margin-top:10px;">
          <button class="btn secondary" onclick="clearLog()" style="flex:1;">清空日志</button>
          <button class="btn secondary" onclick="showSeenNumbers()" style="flex:1;">查看已扫号码（去重）</button>
        </div>
      </div>
    </div>

    <!-- 添加账号页 -->
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
  let grabbedAccounts = JSON.parse(localStorage.getItem('grabbed_accounts') || '[]');
  let grabInterval = null;
  let captchaKey = '';
  let totalScanned = 0;

  // 新增：记录已扫到的号码（去重）
  let seenNumbers = new Set();
  let seenNumbersList = [];

  function saveAccounts() { localStorage.setItem('grabber_accounts', JSON.stringify(accounts)); }
  function saveGrabbed() { localStorage.setItem('grabbed_accounts', JSON.stringify(grabbedAccounts)); }

  function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function goMain() {
    showPage('pageMain');
    renderAccounts();
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
      const isGrabbed = grabbedAccounts.includes(acc.email);
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #eee;';
      div.innerHTML = \`
        <div>
          <strong>\${acc.email}</strong>
          \${isGrabbed ? '<span style="color:#c8102e;font-size:12px;margin-left:8px;">[已抢/锁定]</span>' : ''}
        </div>
        <div>
          <button onclick="resetAccount(\${index})" style="padding:4px 10px;font-size:12px;">重置</button>
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
      if (!grabbedAccounts.includes(acc.email)) {
        const opt = document.createElement('option');
        opt.value = index;
        opt.textContent = acc.email;
        select.appendChild(opt);
      }
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
    accounts.splice(index, 1);
    grabbedAccounts = grabbedAccounts.filter(e => e !== email);
    saveAccounts();
    saveGrabbed();
    renderAccounts();
  }

  function resetAccount(index) {
    const email = accounts[index].email;
    grabbedAccounts = grabbedAccounts.filter(e => e !== email);
    saveGrabbed();
    renderAccounts();
    alert('已重置');
  }

  function addLog(text) {
    const log = document.getElementById('log');
    const time = new Date().toLocaleTimeString();
    log.innerHTML = \`<div class="log-item">[\${time}] \${text}</div>\` + log.innerHTML;
  }

  function updateScanCount() {
    document.getElementById('scanCount').textContent = \`共轮询 \${totalScanned} 次\`;
  }

  function clearLog() {
    document.getElementById('log').innerHTML = '';
    totalScanned = 0;
    updateScanCount();
  }

  // ==================== 正确的匹配逻辑 ====================
  function matchesPattern(last4, pattern) {
    if (!last4 || last4.length !== 4) return false;
    const [a, b, c, d] = last4.split('');
    
    if (pattern === 'aaaa') return a === b && b === c && c === d;
    if (pattern === 'aaab') return a === b && b === c && c !== d;
    if (pattern === 'abbb') return a !== b && b === c && c === d;
    if (pattern === 'abab') return a === c && b === d && a !== b;
    if (pattern === 'abba') return a === d && b === c && a !== b;
    return false;
  }

  async function checkHasPaidNumber(token) {
    try {
      const res = await fetch('/api/userPhonePurchase/getOrderPage?page=1&size=10&status=1&phone=', { headers: { token } });
      const json = await res.json();
      return json.data?.records?.length > 0;
    } catch (e) { return false; }
  }

  async function getNewNumber(token) {
    const res = await fetch('/api/countryCode/getPhoneNumber/CA', { headers: { token } });
    return await res.json();
  }

  async function buyNumber(phoneNumber, token) {
    try {
      const res = await fetch('/api/userPhonePurchase/buyPhoneNumberOrder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token },
        body: JSON.stringify({ phoneNumber, countryCode: 'CA' })
      });
      return await res.json();
    } catch (e) { return { code: 0, message: e.message }; }
  }

  async function confirmPay(orderNo, token) {
    try {
      const res = await fetch('/api/userPhonePurchase/confirmPay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token },
        body: JSON.stringify({ orderNo })
      });
      return await res.json();
    } catch (e) { return { code: 0, message: e.message }; }
  }

  // ==================== 核心抢号逻辑（已修复） ====================
  async function pollOnce() {
    const select = document.getElementById('selectedAccount');
    if (!select.value) return;
    const index = parseInt(select.value);
    const acc = accounts[index];
    if (!acc) return;

    if (grabbedAccounts.includes(acc.email)) {
      addLog(\`\${acc.email} 已抢过，跳过\`);
      stopGrab();
      return;
    }

    const hasPaid = await checkHasPaidNumber(acc.token);
    if (hasPaid) {
      addLog(\`\${acc.email} 已有付费CA号，自动锁定\`);
      grabbedAccounts.push(acc.email);
      saveGrabbed();
      renderAccounts();
      stopGrab();
      return;
    }

    try {
      const numRes = await getNewNumber(acc.token);
      totalScanned++;
      updateScanCount();

      if (numRes.code !== 200 || !Array.isArray(numRes.data) || numRes.data.length === 0) {
        addLog('获取号码失败');
        return;
      }

      // 记录本次扫到的所有号码（去重）
      numRes.data.forEach(item => {
        if (item.phoneNumber && !seenNumbers.has(item.phoneNumber)) {
          seenNumbers.add(item.phoneNumber);
          seenNumbersList.push(item.phoneNumber);
        }
      });

      const patterns = document.getElementById('patterns').value.split(',').map(p => p.trim());
      let matchedPhone = null;
      let matchedClass = '';

      for (const item of numRes.data) {
        if (!item.phoneNumber) continue;
        if (item.buyPrice !== 0.30) continue; // 只买0.3季包

        const last4 = item.phoneNumber.slice(-4);
        for (const pat of patterns) {
          if (matchesPattern(last4, pat)) {
            matchedPhone = item.phoneNumber;
            matchedClass = pat;
            break;
          }
        }
        if (matchedPhone) break;
      }

      if (!matchedPhone) {
        addLog(\`共轮询 \${totalScanned} 次 | 本次无符合条件的号码，跳过\`);
        return;
      }

      addLog(\`发现 \${matchedClass}类 号码 \${matchedPhone}（0.3季包），开始购买...\`);

      const buyRes = await buyNumber(matchedPhone, acc.token);
      let resultText = '';

      if (buyRes.code === 200 && buyRes.data?.orderNo) {
        const payRes = await confirmPay(buyRes.data.orderNo, acc.token);
        resultText = payRes.code === 200 ? '购买成功' : \`付款失败（\${payRes.message || '余额不足'}）→ 已记录为成功\`;
      } else {
        resultText = \`占号失败（\${buyRes.message || '未知'}）→ 已记录为成功\`;
      }

      addLog(\`【锁定】\${matchedClass}类 号码 \${matchedPhone} | \${resultText}\`);
      grabbedAccounts.push(acc.email);
      saveGrabbed();
      renderAccounts();
      stopGrab();

    } catch (e) {
      addLog('出错: ' + e.message);
    }
  }

  function startGrab() {
    if (grabInterval) clearInterval(grabInterval);
    const select = document.getElementById('selectedAccount');
    if (!select.value) { alert('请选择账号'); return; }
    document.getElementById('grabStatus').innerHTML = '<span class="status running">正在抢号中...</span>';
    pollOnce();
    grabInterval = setInterval(pollOnce, 10000);
  }

  function stopGrab() {
    if (grabInterval) clearInterval(grabInterval);
    grabInterval = null;
    document.getElementById('grabStatus').innerHTML = '<span class="status stopped">已停止</span>';
  }

  // 查看已扫到的号码（去重）
  function showSeenNumbers() {
    if (seenNumbersList.length === 0) {
      alert('还没有扫到任何号码');
      return;
    }
    const list = seenNumbersList.join('\\n');
    const win = window.open('', '_blank');
    win.document.write(\`
      <html>
        <head><title>已扫到的号码（共 \${seenNumbersList.length} 个）</title></head>
        <body style="font-family:monospace; padding:20px; white-space:pre-line; line-height:1.6;">
          <h3>已扫到的唯一号码（共 \${seenNumbersList.length} 个）</h3>
          \${list}
        </body>
      </html>
    \`);
  }

  function init() {
    renderAccounts();
    updateScanCount();
  }

  init();
</script>
</body>
</html>`;
