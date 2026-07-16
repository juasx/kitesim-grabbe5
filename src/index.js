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
    body { font-family: system-ui; background: #f5f5f7; margin: 0; padding: 20px; }
    .container { max-width: 720px; margin: 0 auto; }
    .card { background: white; border-radius: 16px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .btn { background: #c8102e; color: white; border: none; padding: 12px 20px; border-radius: 12px; font-size: 15px; cursor: pointer; width: 100%; }
    .btn.secondary { background: #f0f0f3; color: #333; }
    input, select { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 12px; margin-bottom: 12px; }
    .log { background: #f8f9fa; padding: 12px; border-radius: 12px; max-height: 300px; overflow-y: auto; font-size: 13px; }
    .log-item { padding: 6px 0; border-bottom: 1px solid #eee; }
    .status { font-size: 13px; padding: 6px 12px; border-radius: 20px; display: inline-block; }
    .status.running { background: #d4edda; color: #155724; }
    .status.stopped { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <div class="container">
    <h2 style="text-align:center; margin-bottom:24px;">Kite Grabber（多账号抢号器）</h2>

    <!-- 账号管理 -->
    <div class="card">
      <h3>账号管理</h3>
      <div style="display:flex; gap:10px; margin-bottom:12px;">
        <input id="email" placeholder="邮箱">
        <input id="pass" type="password" placeholder="密码">
      </div>
      <button class="btn" onclick="addAccount()">添加账号</button>
      <div id="accountList" style="margin-top:16px;"></div>
    </div>

    <!-- 抢号设置 -->
    <div class="card">
      <h3>抢号设置</h3>
      <div>
        <label>选择账号</label>
        <select id="selectedAccount"></select>
      </div>
      <div style="margin-top:12px;">
        <label>尾号匹配（逗号分隔）</label>
        <input id="patterns" value="aaab,abbb,aaaa" placeholder="aaab,abbb,aaaa">
      </div>
      <div style="margin-top:16px; display:flex; gap:10px;">
        <button class="btn" onclick="startGrab()">开始抢号（每10秒）</button>
        <button class="btn secondary" onclick="stopGrab()">停止</button>
      </div>
      <div id="grabStatus" style="margin-top:12px;"></div>
    </div>

    <!-- 日志 -->
    <div class="card">
      <h3>抢号日志</h3>
      <div id="log" class="log"></div>
      <button class="btn secondary" style="margin-top:12px;" onclick="clearLog()">清空日志</button>
    </div>
  </div>

<script>
  let accounts = JSON.parse(localStorage.getItem('grabber_accounts') || '[]');
  let grabInterval = null;
  let currentAccountIndex = null;
  let grabbedAccounts = JSON.parse(localStorage.getItem('grabbed_accounts') || '[]');

  function saveAccounts() {
    localStorage.setItem('grabber_accounts', JSON.stringify(accounts));
  }

  function saveGrabbed() {
    localStorage.setItem('grabbed_accounts', JSON.stringify(grabbedAccounts));
  }

  function renderAccounts() {
    const container = document.getElementById('accountList');
    container.innerHTML = '';
    
    if (accounts.length === 0) {
      container.innerHTML = '<div style="color:#888;">还没有账号</div>';
      return;
    }

    accounts.forEach((acc, index) => {
      const isGrabbed = grabbedAccounts.includes(acc.email);
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #eee;';
      div.innerHTML = \`
        <div>
          <strong>\${acc.email}</strong>
          \${isGrabbed ? '<span style="color:#c8102e;font-size:12px;margin-left:8px;">[已抢]</span>' : ''}
        </div>
        <div>
          <button onclick="resetAccount(\${index})" style="padding:4px 10px;font-size:12px;">重置</button>
          <button onclick="removeAccount(\${index})" style="padding:4px 10px;font-size:12px;color:#c8102e;">删除</button>
        </div>
      \`;
      container.appendChild(div);
    });

    // 更新选择框
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

  async function addAccount() {
    const email = document.getElementById('email').value.trim();
    const pass = document.getElementById('pass').value;
    if (!email || !pass) return alert('请填写邮箱和密码');

    // 这里简化处理，实际应该调用登录接口
    // 为了演示，我们先手动输入 token（你可以用之前的登录方式获取）
    const token = prompt('请输入该账号的 token（从浏览器开发者工具获取）:');
    if (!token) return;

    accounts.push({ email, token });
    saveAccounts();
    renderAccounts();
    document.getElementById('email').value = '';
    document.getElementById('pass').value = '';
  }

  function removeAccount(index) {
    if (!confirm('确定删除该账号？')) return;
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
    alert('已重置该账号，可再次抢号');
  }

  function addLog(text) {
    const log = document.getElementById('log');
    const time = new Date().toLocaleTimeString();
    log.innerHTML = \`<div class="log-item">[\${time}] \${text}</div>\` + log.innerHTML;
  }

  function clearLog() {
    document.getElementById('log').innerHTML = '';
  }

  async function checkHasPaidNumber(token) {
    try {
      const res = await fetch('/api/userPhonePurchase/getOrderPage?page=1&size=10&status=1&phone=', {
        headers: { token }
      });
      const json = await res.json();
      return json.data && json.data.records && json.data.records.length > 0;
    } catch (e) {
      return false;
    }
  }

  async function getNewNumber(token) {
    const res = await fetch('/api/countryCode/getPhoneNumber/CA', {
      headers: { token }
    });
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
    } catch (e) {
      return { code: 0, message: e.message };
    }
  }

  async function confirmPay(orderNo, token) {
    try {
      const res = await fetch('/api/userPhonePurchase/confirmPay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token },
        body: JSON.stringify({ orderNo })
      });
      return await res.json();
    } catch (e) {
      return { code: 0, message: e.message };
    }
  }

  async function pollOnce() {
    const select = document.getElementById('selectedAccount');
    if (!select.value) return;

    const index = parseInt(select.value);
    const acc = accounts[index];
    if (!acc) return;

    // 检查是否已抢过
    if (grabbedAccounts.includes(acc.email)) {
      addLog(\`\${acc.email} 已抢过，跳过\`);
      stopGrab();
      return;
    }

    // 检查是否已有付费号码
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
      if (numRes.code !== 200 || !numRes.data?.phoneNumber) {
        addLog('获取号码失败');
        return;
      }

      const phone = numRes.data.phoneNumber;
      const last4 = phone.slice(-4);

      const patterns = document.getElementById('patterns').value.split(',').map(p => p.trim());
      const matched = patterns.some(p => last4 === p);

      if (!matched) {
        addLog(\`获取 \${phone}，不匹配，跳过\`);
        return;
      }

      addLog(\`匹配成功！\${phone}，正在自动购买...\`);

      // 尝试购买
      const buyRes = await buyNumber(phone, acc.token);
      
      if (buyRes.code === 200 && buyRes.data?.orderNo) {
        const payRes = await confirmPay(buyRes.data.orderNo, acc.token);
        
        if (payRes.code === 200) {
          addLog(\`✅ 抢号成功！\${phone}\`);
        } else {
          addLog(\`付款失败（余额不足或其他）：\${payRes.message || '未知'} → 已记录为成功\`);
        }
      } else {
        addLog(\`占号失败：\${buyRes.message || '未知'} → 已记录为成功\`);
      }

      // 无论成功失败，都标记为已抢
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
    if (!select.value) {
      alert('请选择账号');
      return;
    }

    document.getElementById('grabStatus').innerHTML = '<span class="status running">正在抢号中...</span>';
    
    pollOnce(); // 立即执行一次
    grabInterval = setInterval(pollOnce, 10000);
  }

  function stopGrab() {
    if (grabInterval) {
      clearInterval(grabInterval);
      grabInterval = null;
    }
    document.getElementById('grabStatus').innerHTML = '<span class="status stopped">已停止</span>';
  }

  // 初始化
  function init() {
    renderAccounts();
    updateAccountSelect();
  }

  init();
</script>
</body>
</html>`;
