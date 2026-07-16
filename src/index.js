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
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kite Grabber</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f5f5f7; padding: 16px; }
    .container { max-width: 720px; margin: 0 auto; }
    .card { background: white; border-radius: 16px; padding: 18px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .btn { background: #c8102e; color: white; border: none; padding: 12px 18px; border-radius: 12px; font-size: 15px; cursor: pointer; width: 100%; }
    .btn.secondary { background: #f0f0f3; color: #333; }
    input, select { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 12px; margin-bottom: 12px; font-size: 15px; }
    .log { background: #f8f9fa; padding: 12px; border-radius: 12px; max-height: 320px; overflow-y: auto; font-size: 13px; }
    .status { font-size: 13px; padding: 6px 12px; border-radius: 20px; }
    .status.running { background: #d4edda; color: #155724; }
    .status.stopped { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Kite Grabber - CA 0.3季包（已加未支付校验）</h2>
    
    <div class="card">
      <h3>已添加账号</h3>
      <div id="accountList"></div>
      <button class="btn secondary" onclick="goAddAccount()" style="margin-top:12px;">添加账号</button>
    </div>

    <div class="card">
      <h3>抢号设置</h3>
      <select id="selectedAccount" style="margin-bottom:12px;"></select>
      
      <label>匹配规则（aaab, abbb, aaaa, abab, abba）</label>
      <input id="patterns" value="aaab, abbb, aaaa, abab, abba">
      
      <div style="margin:16px 0; display:flex; gap:10px;">
        <button class="btn" onclick="startGrab()">开始抢号（每10秒）</button>
        <button class="btn secondary" onclick="stopGrab()">停止</button>
      </div>
      <div id="grabStatus"></div>
      <div>已扫描：<span id="scanCount">0</span> 次</div>
    </div>

    <div class="card">
      <h3>日志</h3>
      <div id="log" class="log"></div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn secondary" onclick="clearLog()" style="flex:1;">清空日志</button>
        <button class="btn secondary" onclick="showSeenNumbers()" style="flex:1;">查看已扫号码（去重）</button>
      </div>
    </div>
  </div>

<script>
  let accounts = JSON.parse(localStorage.getItem('grabber_accounts') || '[]');
  let grabbedAccounts = JSON.parse(localStorage.getItem('grabbed_accounts') || '[]');
  let grabInterval = null;
  let totalScanned = 0;
  let seenNumbers = new Set();
  let seenNumbersList = [];

  function saveAccounts() { localStorage.setItem('grabber_accounts', JSON.stringify(accounts)); }
  function saveGrabbed() { localStorage.setItem('grabbed_accounts', JSON.stringify(grabbedAccounts)); }

  function addLog(text) {
    const log = document.getElementById('log');
    const time = new Date().toLocaleTimeString();
    log.innerHTML = `<div>[${time}] ${text}</div>` + log.innerHTML;
  }

  function updateScanCount() {
    document.getElementById('scanCount').textContent = totalScanned;
  }

  function renderAccounts() {
    const container = document.getElementById('accountList');
    container.innerHTML = '';
    accounts.forEach((acc, i) => {
      const isLocked = grabbedAccounts.includes(acc.email);
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #eee;';
      div.innerHTML = `
        <div><strong>${acc.email}</strong> ${isLocked ? '<span style="color:#c8102e">[已锁定]</span>' : ''}</div>
        <div>
          <button onclick="resetAccount(${i})">重置</button>
          <button onclick="removeAccount(${i})" style="color:#c8102e">删除</button>
        </div>`;
      container.appendChild(div);
    });
    updateAccountSelect();
  }

  function updateAccountSelect() {
    const select = document.getElementById('selectedAccount');
    select.innerHTML = '';
    accounts.forEach((acc, i) => {
      if (!grabbedAccounts.includes(acc.email)) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = acc.email;
        select.appendChild(opt);
      }
    });
  }

  function removeAccount(i) {
    if (!confirm('确定删除？')) return;
    const email = accounts[i].email;
    accounts.splice(i, 1);
    grabbedAccounts = grabbedAccounts.filter(e => e !== email);
    saveAccounts();
    saveGrabbed();
    renderAccounts();
  }

  function resetAccount(i) {
    const email = accounts[i].email;
    grabbedAccounts = grabbedAccounts.filter(e => e !== email);
    saveGrabbed();
    renderAccounts();
    alert('已重置');
  }

  function clearLog() {
    document.getElementById('log').innerHTML = '';
    totalScanned = 0;
    updateScanCount();
  }

  function showSeenNumbers() {
    if (seenNumbersList.length === 0) {
      alert('还没有扫到号码');
      return;
    }
    const w = window.open('', '_blank');
    w.document.write(`<pre>已扫到 ${seenNumbersList.length} 个唯一号码：\n\n${seenNumbersList.join('\n')}</pre>`);
  }

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
    } catch { return false; }
  }

  // 新增：校验未支付列表（status=2）
  async function checkUnpaidNumber(phone, token) {
    try {
      const res = await fetch(`/api/userPhonePurchase/getOrderPage?page=1&size=20&status=2&phone=`, { headers: { token } });
      const json = await res.json();
      if (json.code === 200 && json.data?.records) {
        return json.data.records.some(r => r.phoneNumber === phone);
      }
      return false;
    } catch { return false; }
  }

  async function getNewNumber(token) {
    const res = await fetch('/api/countryCode/getPhoneNumber/CA', { headers: { token } });
    return await res.json();
  }

  async function buyNumber(phone, token) {
    try {
      const res = await fetch('/api/userPhonePurchase/buyPhoneNumberOrder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token },
        body: JSON.stringify({ phoneNumber: phone, countryCode: 'CA' })
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

  // ==================== 核心逻辑（已增加未支付校验） ====================
  async function pollOnce() {
    const select = document.getElementById('selectedAccount');
    if (!select.value) return;
    const acc = accounts[parseInt(select.value)];
    if (!acc || grabbedAccounts.includes(acc.email)) return;

    const hasPaid = await checkHasPaidNumber(acc.token);
    if (hasPaid) {
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

      if (numRes.code !== 200 || !numRes.data?.length) return;

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
        if (item.buyPrice !== 0.30) continue;
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
        addLog(`共轮询 ${totalScanned} 次 | 无符合号码`);
        return;
      }

      addLog(`发现 ${matchedClass}类 号码 ${matchedPhone}，开始占号...`);

      const buyRes = await buyNumber(matchedPhone, acc.token);

      if (buyRes.code === 200 && buyRes.data?.orderNo) {
        // 关键：占号后校验未支付列表
        addLog(`占号接口返回成功，正在校验未支付列表...`);
        const isInUnpaid = await checkUnpaidNumber(matchedPhone, acc.token);

        if (isInUnpaid) {
          addLog(`【占号成功并已校验】${matchedClass}类 号码 ${matchedPhone}（未支付列表已出现）`);

          try {
            await confirmPay(buyRes.data.orderNo, acc.token);
          } catch (e) {}

          grabbedAccounts.push(acc.email);
          saveGrabbed();
          renderAccounts();
          stopGrab();
        } else {
          addLog(`【占号后校验失败】${matchedPhone} 未在未支付列表中出现`);
        }
      } else {
        addLog(`【占号失败】${matchedClass}类 号码 ${matchedPhone} | ${buyRes.message || 'Server Exception'}`);
      }

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

  function init() {
    renderAccounts();
    updateScanCount();
  }
  init();
</script>
</body>
</html>`;
