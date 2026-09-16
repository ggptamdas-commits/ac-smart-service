// AC Smart Service Dashboard - Production Worker Backend with Settings Hub
let cachedHtml = null;
let lastFetchTime = 0;

async function getDashboardHTML(env) {
  const now = Date.now();
  if (cachedHtml && (now - lastFetchTime < 60000)) {
    return cachedHtml;
  }
  try {
    const row = await env.DB.prepare("SELECT value FROM business_settings WHERE key = 'dashboard_html'").first();
    if (row && row.value && row.value.length > 1000) {
      cachedHtml = row.value;
      lastFetchTime = now;
      return cachedHtml;
    }
  } catch (e) {
    console.error('Error fetching dashboard from D1:', e);
  }

  try {
    const res = await fetch('https://raw.githubusercontent.com/ggptamdas-commits/ac-smart-service/main/dashboard/index.html', {
      headers: { 'User-Agent': 'Cloudflare-Worker' }
    });
    if (res.ok) {
      cachedHtml = await res.text();
      lastFetchTime = now;
      return cachedHtml;
    }
  } catch (err) {
    console.error('Error fetching dashboard from GitHub:', err);
  }

  if (cachedHtml) return cachedHtml;
  return '<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><title>AC Smart Service</title><meta http-equiv="refresh" content="3"><script src="https://cdn.tailwindcss.com"></script></head><body class="flex items-center justify-center h-screen bg-slate-900 text-white"><div class="text-center"><h1 class="text-2xl font-bold">❄️ AC Smart Service Dashboard</h1><p class="text-slate-400 mt-2">ড্যাশবোর্ড সিঙ্ক হচ্ছে... অনুগ্রহ করে ৩ সেকেন্ড অপেক্ষা করুন।</p></div></body></html>';
}

async function getRuntimeSetting(env, key, defaultVal = '') {
  try {
    const row = await env.DB.prepare('SELECT value FROM business_settings WHERE key = ?').bind(key).first();
    if (row && row.value !== undefined && row.value !== null && row.value !== '') {
      return row.value;
    }
  } catch (e) {}
  return env[key] || defaultVal;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'pbkdf2$' + saltHex + '$' + hashHex;
}

async function verifyPassword(password, storedHash) {
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
    const saltHex = parts[1];
    const targetHashHex = parts[2];
    const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      256
    );
    const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex === targetHashHex;
  } catch (e) {
    return false;
  }
}

function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
      ...extraHeaders
    }
  });
}

function errorResponse(message, code = 'BAD_REQUEST', status = 400) {
  return jsonResponse({ success: false, error: { code, message } }, status);
}

function successResponse(data, status = 200, extraHeaders = {}) {
  return jsonResponse({ success: true, data }, status, extraHeaders);
}

async function getAuthUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else {
    const cookie = request.headers.get('Cookie');
    if (cookie) {
      const match = cookie.match(/ac_session=([a-f0-9]+)/);
      if (match) token = match[1];
    }
  }
  if (!token) return null;

  const session = await env.DB.prepare(
    'SELECT s.*, u.email, u.name, u.role, u.active FROM sessions s JOIN admin_users u ON s.admin_id = u.id WHERE s.id = ? AND s.expires_at > datetime("now")'
  ).bind(token).first();

  if (!session || !session.active) return null;
  return session;
}

async function logAudit(env, adminId, action, tableName, recordId, changes, ip = '') {
  try {
    await env.DB.prepare(
      'INSERT INTO audit_logs (admin_id, action, table_name, record_id, changes, ip_hash) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(adminId, action, tableName, recordId, typeof changes === 'string' ? changes : JSON.stringify(changes), ip).run();
  } catch (err) {
    console.error('Audit log failed:', err);
  }
}

async function sendWhatsAppMessage(env, phone, text) {
  const apiUrl = await getRuntimeSetting(env, 'EVOLUTION_API_URL');
  const apiKey = await getRuntimeSetting(env, 'EVOLUTION_API_KEY');
  const instance = await getRuntimeSetting(env, 'EVOLUTION_INSTANCE');

  if (!apiUrl || !apiKey || !instance) {
    console.warn('Evolution API not configured. Local simulation:', text);
    return { simulated: true, success: true };
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const url = `${apiUrl.replace(/\/$/, '')}/message/sendText/${instance}`;
  
  const payload = {
    number: cleanPhone,
    options: { delay: 1200, presence: 'composing', linkPreview: false },
    textMessage: { text }
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey
      },
      body: JSON.stringify(payload)
    });
    const result = await resp.json();
    return { success: resp.ok, result };
  } catch (err) {
    console.error('Error sending WhatsApp message via Evolution API:', err);
    return { success: false, error: err.message };
  }
}

async function processWithAI(env, customer, incomingText, recentMessages) {
  const promptRow = await env.DB.prepare("SELECT value FROM bot_flow_config WHERE key = 'system_prompt'").first();
  const systemPrompt = promptRow ? promptRow.value : 'আপনি "এসি কেয়ার টিম"-এর একজন পেশাদার WhatsApp AC service assistant।';

  const aiProvider = await getRuntimeSetting(env, 'AI_PROVIDER', 'fallback');
  const aiModel = await getRuntimeSetting(env, 'AI_MODEL', '');
  const aiApiKey = await getRuntimeSetting(env, 'AI_API_KEY', '');

  const history = recentMessages.map(m => ({
    role: m.sender === 'customer' ? 'user' : 'assistant',
    content: m.text || ''
  }));
  history.push({ role: 'user', content: incomingText });

  const aiInstructions = `${systemPrompt}

CURRENT CUSTOMER CONTEXT:
- Customer ID: ${customer.id}
- Name: ${customer.name || 'অজানা'}
- Phone: ${customer.phone}
- Saved Address: ${customer.address || 'নথিভুক্ত নেই'}
- Status: ${customer.status}

STRICT JSON OUTPUT REQUIREMENT:
You must reply ONLY in raw valid JSON format matching this schema:
{
  "reply": "বাংলা ভাষায় গ্রাহকের জন্য বন্ধুত্বপূর্ণ উত্তর",
  "intent": "general_query" | "service_request" | "inquiry" | "handover",
  "state": "collecting_info" | "ready_to_create" | "completed",
  "customer_update": {
    "name": "optional updated name",
    "address": "optional updated address"
  },
  "tool_call": null or {
    "name": "create_service_request",
    "arguments": {
      "issue_description": "এসির সমস্যার বর্ণনা",
      "address": "সার্ভিসের ঠিকানা",
      "preferred_date": "সুবিধাজনক তারিখ (optional)",
      "preferred_time": "সুবিধাজনক সময় (optional)"
    }
  } or {
    "name": "handover_to_human",
    "arguments": {
      "reason": "Customer requested human or emergency"
    }
  }
}
CRITICAL RULES:
1. Never guess technician availability, price, or exact arrival time.
2. If customer gives their address and issue, you can trigger create_service_request tool_call.
3. Do NOT include markdown code blocks like \`\`\`json. Output raw JSON only.`;

  if (aiApiKey && (aiProvider === 'anthropic' || aiProvider === 'openai')) {
    try {
      if (aiProvider === 'anthropic') {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': aiApiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: aiModel || 'claude-3-5-sonnet-20241022',
            max_tokens: 800,
            system: aiInstructions,
            messages: history
          })
        });
        const data = await resp.json();
        if (data.content && data.content[0] && data.content[0].text) {
          const rawText = data.content[0].text.trim().replace(/^```json/, '').replace(/```$/, '').trim();
          return JSON.parse(rawText);
        }
      } else if (aiProvider === 'openai') {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${aiApiKey}`
          },
          body: JSON.stringify({
            model: aiModel || 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: aiInstructions },
              ...history
            ]
          })
        });
        const data = await resp.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          return JSON.parse(data.choices[0].message.content);
        }
      }
    } catch (err) {
      console.error('AI provider call failed:', err);
    }
  }

  const lower = incomingText.toLowerCase();
  if (lower.includes('মানুষ') || lower.includes('agent') || lower.includes('কথা বলব') || lower.includes('জরুরি') || lower.includes('human')) {
    return {
      reply: 'আপনার অনুরোধটি আমাদের স্পেশালিস্ট টিমের কাছে স্থানান্তর করা হয়েছে। একজন দক্ষ প্রতিনিধি শীঘ্রই আপনার সাথে যোগাযোগ করবেন।',
      intent: 'handover',
      state: 'completed',
      customer_update: {},
      tool_call: { name: 'handover_to_human', arguments: { reason: 'User requested human agent' } }
    };
  }

  const isAddressGiven = customer.address || lower.includes('রোড') || lower.includes('বাসা') || lower.includes('গ্রাম') || lower.includes('জেলা') || lower.includes('street') || lower.includes('house') || lower.includes('صبيا');
  const isIssueGiven = lower.includes('ঠান্ডা') || lower.includes('পানি') || lower.includes('শব্দ') || lower.includes('গ্যাস') || lower.includes('কুলিং') || lower.includes('লিক') || lower.includes('ac') || lower.includes('সার্ভিস');

  if (isIssueGiven && isAddressGiven) {
    return {
      reply: 'ধন্যবাদ! আপনার সমস্যা ও ঠিকানার তথ্য পেয়েছি। সার্ভিস রিকোয়েস্ট তৈরি করা হচ্ছে। আমাদের প্রতিনিধি শীঘ্রই সময় চূড়ান্ত করতে যোগাযোগ করবেন।',
      intent: 'service_request',
      state: 'ready_to_create',
      customer_update: !customer.address ? { address: incomingText } : {},
      tool_call: {
        name: 'create_service_request',
        arguments: {
          issue_description: incomingText,
          address: customer.address || incomingText,
          preferred_date: 'যেকোনো সময়',
          preferred_time: 'সকাল/বিকাল'
        }
      }
    };
  }

  if (isIssueGiven && !customer.address) {
    return {
      reply: 'আপনার এসির সমস্যাটি বুঝতে পেরেছি। সার্ভিসিংয়ের জন্য অনুগ্রহ করে আপনার সম্পূর্ণ ঠিকানা এবং সুবিধাজনক সময়টি লিখে পাঠান।',
      intent: 'service_request',
      state: 'collecting_info',
      customer_update: {},
      tool_call: null
    };
  }

  return {
    reply: 'আসসালামু আলাইকুম! এসি কেয়ার টিমে স্বাগতম। আপনার এসিতে কী ধরনের সমস্যা হচ্ছে (যেমন: ঠান্ডা না হওয়া, পানি পড়া, গ্যাস রিফিল) তা দয়া করে বিস্তারিত জানাবেন কি?',
    intent: 'general_query',
    state: 'collecting_info',
    customer_update: {},
    tool_call: null
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (path === '/api/health') {
      try {
        const dbRes = await env.DB.prepare('SELECT count(*) as cnt FROM admin_users').first();
        return jsonResponse({ status: 'ok', db_connected: true, admin_count: dbRes.cnt });
      } catch (err) {
        return jsonResponse({ status: 'error', db_connected: false, error: err.message }, 500);
      }
    }

    if (path === '/' || path === '/dashboard') {
      const html = await getDashboardHTML(env);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/webhook/messages') {
      if (method !== 'POST') return errorResponse('Method not allowed', 'METHOD_NOT_ALLOWED', 405);

      try {
        const payload = await request.json();
        let isFromMe = false;
        let whatsappMessageId = null;
        let phone = null;
        let pushName = null;
        let text = '';

        if (payload.data) {
          const mData = payload.data;
          isFromMe = mData.key?.fromMe || false;
          whatsappMessageId = mData.key?.id;
          phone = mData.key?.remoteJid ? mData.key.remoteJid.split('@')[0] : null;
          pushName = mData.pushName || null;
          text = mData.message?.conversation ||
                 mData.message?.extendedTextMessage?.text ||
                 mData.message?.imageMessage?.caption || '';
        } else if (payload.message) {
          isFromMe = payload.fromMe || false;
          whatsappMessageId = payload.id;
          phone = payload.phone || (payload.sender ? payload.sender.split('@')[0] : null);
          pushName = payload.pushName || null;
          text = typeof payload.message === 'string' ? payload.message : payload.message.text || '';
        }

        if (isFromMe) {
          return successResponse({ status: 'ignored_from_me' });
        }

        if (!phone || !whatsappMessageId) {
          return errorResponse('Missing phone or whatsapp message id', 'INVALID_PAYLOAD');
        }

        const existing = await env.DB.prepare('SELECT id FROM messages WHERE whatsapp_message_id = ?').bind(whatsappMessageId).first();
        if (existing) {
          return successResponse({ status: 'already_processed', message_id: existing.id });
        }

        let customer = await env.DB.prepare('SELECT * FROM customers WHERE phone = ?').bind(phone).first();
        if (!customer) {
          const insertRes = await env.DB.prepare(
            'INSERT INTO customers (name, phone, status, bot_enabled, human_takeover) VALUES (?, ?, "new", 1, 0)'
          ).bind(pushName || 'WhatsApp Customer', phone).run();
          customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(insertRes.meta.last_row_id).first();
        } else if (pushName && (!customer.name || customer.name === 'WhatsApp Customer')) {
          await env.DB.prepare('UPDATE customers SET name = ? WHERE id = ?').bind(pushName, customer.id).run();
          customer.name = pushName;
        }

        let conversation = await env.DB.prepare(
          'SELECT * FROM conversations WHERE customer_id = ? AND status = "active"'
        ).bind(customer.id).first();

        if (!conversation) {
          const convRes = await env.DB.prepare(
            'INSERT INTO conversations (customer_id, status) VALUES (?, "active")'
          ).bind(customer.id).run();
          conversation = { id: convRes.meta.last_row_id };
        }

        await env.DB.prepare(
          'INSERT INTO messages (customer_id, conversation_id, whatsapp_message_id, sender, text, message_type, delivery_status) VALUES (?, ?, ?, "customer", ?, "text", "received")'
        ).bind(customer.id, conversation.id, whatsappMessageId, text).run();

        await env.DB.prepare('UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?').bind(conversation.id).run();

        if (customer.human_takeover === 1 || customer.bot_enabled === 0) {
          return successResponse({ status: 'saved_human_takeover_active' });
        }

        const recentMessagesResult = await env.DB.prepare(
          'SELECT sender, text, timestamp FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT 10'
        ).bind(customer.id).all();
        const recentMessages = (recentMessagesResult.results || []).reverse();

        const aiOutput = await processWithAI(env, customer, text, recentMessages);

        if (aiOutput.tool_call) {
          const tool = aiOutput.tool_call;
          if (tool.name === 'create_service_request' && tool.arguments) {
            const args = tool.arguments;
            const reqRes = await env.DB.prepare(
              `INSERT INTO service_requests (customer_id, conversation_id, issue_description, address, preferred_date, preferred_time, status)
               VALUES (?, ?, ?, ?, ?, ?, 'pending')`
            ).bind(
              customer.id,
              conversation.id,
              args.issue_description || text,
              args.address || customer.address || 'অজানা ঠিকানা',
              args.preferred_date || 'সুবিধাজনক তারিখ',
              args.preferred_time || ''
            ).run();

            if (args.address && !customer.address) {
              await env.DB.prepare('UPDATE customers SET address = ? WHERE id = ?').bind(args.address, customer.id).run();
            }

            await logAudit(env, null, 'AI_CREATE_REQUEST', 'service_requests', reqRes.meta.last_row_id, args);
          } else if (tool.name === 'handover_to_human') {
            await env.DB.prepare('UPDATE customers SET human_takeover = 1 WHERE id = ?').bind(customer.id).run();
            await env.DB.prepare('UPDATE conversations SET status = "human" WHERE customer_id = ?').bind(conversation.id).run();
            await logAudit(env, null, 'AI_HANDOVER', 'customers', customer.id, tool.arguments);
          }
        }

        if (aiOutput.customer_update) {
          if (aiOutput.customer_update.address && !customer.address) {
            await env.DB.prepare('UPDATE customers SET address = ? WHERE id = ?').bind(aiOutput.customer_update.address, customer.id).run();
          }
          if (aiOutput.customer_update.name && customer.name === 'WhatsApp Customer') {
            await env.DB.prepare('UPDATE customers SET name = ? WHERE id = ?').bind(aiOutput.customer_update.name, customer.id).run();
          }
        }

        const replyText = aiOutput.reply || 'ধন্যবাদ, আপনার বার্তা পেয়েছি।';
        const sendResult = await sendWhatsAppMessage(env, phone, replyText);

        await env.DB.prepare(
          'INSERT INTO messages (customer_id, conversation_id, sender, text, message_type, delivery_status, ai_processed) VALUES (?, ?, "bot", ?, "text", ?, 1)'
        ).bind(customer.id, conversation.id, replyText, sendResult.success ? 'sent' : 'failed').run();

        return successResponse({
          status: 'success',
          reply: replyText,
          tool_executed: aiOutput.tool_call?.name || null
        });
      } catch (err) {
        console.error('Webhook error:', err);
        return errorResponse(err.message, 'INTERNAL_SERVER_ERROR', 500);
      }
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const { email, password } = await request.json();
      if (!email || !password) return errorResponse('Email and password required', 'VALIDATION_ERROR');

      const user = await env.DB.prepare('SELECT * FROM admin_users WHERE email = ?').bind(email).first();
      if (!user) return errorResponse('Invalid credentials', 'AUTH_FAILED', 401);

      const isValid = await verifyPassword(password, user.password_hash);
      if (!isValid) return errorResponse('Invalid credentials', 'AUTH_FAILED', 401);

      const sessionId = generateToken();
      await env.DB.prepare(
        'INSERT INTO sessions (id, admin_id, expires_at) VALUES (?, ?, datetime("now", "+30 days"))'
      ).bind(sessionId, user.id).run();

      await env.DB.prepare('UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run();
      await logAudit(env, user.id, 'LOGIN', 'admin_users', user.id, { email });

      const cookie = `ac_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
      return successResponse({ token: sessionId, user: { id: user.id, email: user.email, name: user.name, role: user.role } }, 200, { 'Set-Cookie': cookie });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const user = await getAuthUser(request, env);
      if (user) {
        await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(user.id).run();
      }
      return successResponse({ logged_out: true }, 200, { 'Set-Cookie': 'ac_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
    }

    if (path === '/api/auth/me' && method === 'GET') {
      const user = await getAuthUser(request, env);
      if (!user) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);
      return successResponse({ user: { id: user.admin_id, email: user.email, name: user.name, role: user.role } });
    }

    const authUser = await getAuthUser(request, env);
    if (!authUser) {
      return errorResponse('Unauthorized access. Please login.', 'UNAUTHORIZED', 401);
    }

    // ⚙️ SETTINGS ENDPOINTS (GET & POST /api/settings)
    if (path === '/api/settings') {
      if (method === 'GET') {
        const rows = await env.DB.prepare('SELECT key, value FROM business_settings').all();
        const settings = {};
        if (rows.results) {
          rows.results.forEach(r => { settings[r.key] = r.value; });
        }
        const keys = ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE', 'WEBHOOK_SECRET', 'AI_PROVIDER', 'AI_MODEL', 'AI_API_KEY', 'BUSINESS_TIMEZONE', 'CURRENCY'];
        keys.forEach(k => {
          if (!settings[k] && env[k]) settings[k] = env[k];
        });
        return successResponse(settings);
      }
      if (method === 'POST') {
        const body = await request.json();
        for (const [k, v] of Object.entries(body)) {
          await env.DB.prepare(
            'INSERT OR REPLACE INTO business_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
          ).bind(k, String(v)).run();
        }
        await logAudit(env, authUser.admin_id, 'UPDATE_SETTINGS', 'business_settings', null, body);
        return successResponse({ saved: true });
      }
    }

    if (path === '/api/settings/test-evolution' && method === 'POST') {
      const { url, key, instance } = await request.json();
      try {
        const checkUrl = `${url.replace(/\/$/, '')}/instance/connectionState/${instance}`;
        const resp = await fetch(checkUrl, {
          headers: { 'apikey': key }
        });
        const resData = await resp.json();
        return successResponse({ connected: resp.ok, data: resData });
      } catch (err) {
        return errorResponse(err.message, 'CONNECTION_FAILED', 500);
      }
    }

    if (path === '/api/settings/test-ai' && method === 'POST') {
      const { provider, model, key } = await request.json();
      try {
        if (provider === 'anthropic') {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': key,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: model || 'claude-3-5-sonnet-20241022',
              max_tokens: 100,
              messages: [{ role: 'user', content: 'Say hello in Bengali (বাংলায় হ্যালো বলুন)' }]
            })
          });
          const data = await resp.json();
          return successResponse({ reply: data.content?.[0]?.text || JSON.stringify(data) });
        } else if (provider === 'openai') {
          const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
              model: model || 'gpt-4o-mini',
              max_tokens: 100,
              messages: [{ role: 'user', content: 'Say hello in Bengali (বাংলায় হ্যালো বলুন)' }]
            })
          });
          const data = await resp.json();
          return successResponse({ reply: data.choices?.[0]?.message?.content || JSON.stringify(data) });
        } else {
          return successResponse({ reply: 'বিল্ট-ইন বাংলা ইন্টেলিজেন্ট ইঞ্জিন সক্রিয় ও প্রস্তুত আছে!' });
        }
      } catch (err) {
        return errorResponse(err.message, 'AI_TEST_FAILED', 500);
      }
    }

    if (path === '/api/dashboard/stats' && method === 'GET') {
      const customersCnt = await env.DB.prepare('SELECT count(*) as cnt FROM customers').first();
      const activeChatsCnt = await env.DB.prepare('SELECT count(*) as cnt FROM conversations WHERE status = "active"').first();
      const pendingReqsCnt = await env.DB.prepare('SELECT count(*) as cnt FROM service_requests WHERE status = "pending"').first();
      const scheduledReqsCnt = await env.DB.prepare('SELECT count(*) as cnt FROM service_requests WHERE status = "scheduled"').first();
      const completedTodayCnt = await env.DB.prepare('SELECT count(*) as cnt FROM service_requests WHERE status = "completed" AND date(updated_at) = date("now")').first();
      const remindersDueCnt = await env.DB.prepare('SELECT count(*) as cnt FROM customers WHERE next_reminder_date <= date("now")').first();

      return successResponse({
        total_customers: customersCnt.cnt,
        active_conversations: activeChatsCnt.cnt,
        pending_requests: pendingReqsCnt.cnt,
        scheduled_requests: scheduledReqsCnt.cnt,
        completed_today: completedTodayCnt.cnt,
        reminders_due: remindersDueCnt.cnt
      });
    }

    if (path === '/api/customers') {
      if (method === 'GET') {
        const q = url.searchParams.get('q');
        const status = url.searchParams.get('status');
        let sql = 'SELECT * FROM customers WHERE 1=1';
        const params = [];
        if (q) {
          sql += ' AND (name LIKE ? OR phone LIKE ? OR address LIKE ?)';
          params.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        if (status) {
          sql += ' AND status = ?';
          params.push(status);
        }
        sql += ' ORDER BY id DESC';
        const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
        const res = await stmt.all();
        return successResponse(res.results || []);
      }
      if (method === 'POST') {
        const { name, phone, address, notes, status } = await request.json();
        if (!phone) return errorResponse('Phone is required', 'VALIDATION_ERROR');
        const ins = await env.DB.prepare(
          'INSERT INTO customers (name, phone, address, notes, status) VALUES (?, ?, ?, ?, ?)'
        ).bind(name || 'Customer', phone, address || '', notes || '', status || 'new').run();
        await logAudit(env, authUser.admin_id, 'CREATE_CUSTOMER', 'customers', ins.meta.last_row_id, { phone, name });
        return successResponse({ id: ins.meta.last_row_id });
      }
    }

    if (path.startsWith('/api/customers/')) {
      const parts = path.split('/');
      const custId = parseInt(parts[3]);

      if (parts[4] === 'takeover' && method === 'POST') {
        await env.DB.prepare('UPDATE customers SET human_takeover = 1 WHERE id = ?').bind(custId).run();
        await env.DB.prepare('UPDATE conversations SET status = "human" WHERE customer_id = ?').bind(custId).run();
        await logAudit(env, authUser.admin_id, 'TAKEOVER', 'customers', custId, {});
        return successResponse({ human_takeover: 1 });
      }

      if (parts[4] === 'resume-ai' && method === 'POST') {
        await env.DB.prepare('UPDATE customers SET human_takeover = 0 WHERE id = ?').bind(custId).run();
        await env.DB.prepare('UPDATE conversations SET status = "active" WHERE customer_id = ?').bind(custId).run();
        await logAudit(env, authUser.admin_id, 'RESUME_AI', 'customers', custId, {});
        return successResponse({ human_takeover: 0 });
      }

      if (parts[4] === 'messages') {
        if (method === 'GET') {
          const msgs = await env.DB.prepare(
            'SELECT * FROM messages WHERE customer_id = ? ORDER BY id ASC'
          ).bind(custId).all();
          return successResponse(msgs.results || []);
        }
        if (method === 'POST') {
          const { text } = await request.json();
          if (!text) return errorResponse('Text required');
          const customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(custId).first();
          if (!customer) return errorResponse('Customer not found', 'NOT_FOUND', 404);

          const sendRes = await sendWhatsAppMessage(env, customer.phone, text);
          const ins = await env.DB.prepare(
            'INSERT INTO messages (customer_id, sender, text, message_type, delivery_status) VALUES (?, "admin", ?, "text", ?)'
          ).bind(custId, text, sendRes.success ? 'sent' : 'failed').run();

          await logAudit(env, authUser.admin_id, 'ADMIN_REPLY', 'messages', ins.meta.last_row_id, { customer_id: custId, text });
          return successResponse({ message_id: ins.meta.last_row_id, delivered: sendRes.success });
        }
      }

      if (method === 'GET') {
        const cust = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(custId).first();
        if (!cust) return errorResponse('Customer not found', 'NOT_FOUND', 404);
        return successResponse(cust);
      }

      if (method === 'PUT') {
        const body = await request.json();
        await env.DB.prepare(
          'UPDATE customers SET name = coalesce(?, name), address = coalesce(?, address), notes = coalesce(?, notes), status = coalesce(?, status), updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(body.name, body.address, body.notes, body.status, custId).run();
        await logAudit(env, authUser.admin_id, 'UPDATE_CUSTOMER', 'customers', custId, body);
        return successResponse({ updated: true });
      }
    }

    if (path === '/api/service-requests') {
      if (method === 'GET') {
        const status = url.searchParams.get('status');
        let sql = `
          SELECT sr.*, c.name as customer_name, c.phone as customer_phone
          FROM service_requests sr
          JOIN customers c ON sr.customer_id = c.id
          WHERE 1=1
        `;
        const params = [];
        if (status) {
          sql += ' AND sr.status = ?';
          params.push(status);
        }
        sql += ' ORDER BY sr.id DESC';
        const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
        const res = await stmt.all();
        return successResponse(res.results || []);
      }
      if (method === 'POST') {
        const body = await request.json();
        const ins = await env.DB.prepare(
          `INSERT INTO service_requests (customer_id, issue_description, address, preferred_date, preferred_time, status, notes)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`
        ).bind(body.customer_id, body.issue_description, body.address, body.preferred_date || '', body.preferred_time || '', body.notes || '').run();
        await logAudit(env, authUser.admin_id, 'CREATE_REQUEST', 'service_requests', ins.meta.last_row_id, body);
        return successResponse({ id: ins.meta.last_row_id });
      }
    }

    if (path.startsWith('/api/service-requests/')) {
      const id = parseInt(path.split('/')[3]);
      if (method === 'GET') {
        const reqRow = await env.DB.prepare(
          `SELECT sr.*, c.name as customer_name, c.phone as customer_phone
           FROM service_requests sr
           JOIN customers c ON sr.customer_id = c.id
           WHERE sr.id = ?`
        ).bind(id).first();
        if (!reqRow) return errorResponse('Service request not found', 'NOT_FOUND', 404);
        return successResponse(reqRow);
      }
      if (method === 'PUT') {
        const body = await request.json();
        await env.DB.prepare(
          `UPDATE service_requests SET
             issue_description = coalesce(?, issue_description),
             address = coalesce(?, address),
             scheduled_date = coalesce(?, scheduled_date),
             scheduled_time = coalesce(?, scheduled_time),
             technician_assigned = coalesce(?, technician_assigned),
             status = coalesce(?, status),
             cost_estimate = coalesce(?, cost_estimate),
             cost_final = coalesce(?, cost_final),
             payment_status = coalesce(?, payment_status),
             notes = coalesce(?, notes),
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(
          body.issue_description, body.address, body.scheduled_date, body.scheduled_time,
          body.technician_assigned, body.status, body.cost_estimate, body.cost_final,
          body.payment_status, body.notes, id
        ).run();

        if (body.status === 'completed') {
          const reqRow = await env.DB.prepare('SELECT customer_id FROM service_requests WHERE id = ?').bind(id).first();
          if (reqRow) {
            const today = new Date().toISOString().split('T')[0];
            const remSetting = await env.DB.prepare('SELECT interval_days FROM reminder_settings WHERE active = 1 LIMIT 1').first();
            const interval = remSetting ? remSetting.interval_days : 90;
            const nextDate = new Date();
            nextDate.setDate(nextDate.getDate() + interval);
            const nextDateStr = nextDate.toISOString().split('T')[0];

            await env.DB.prepare(
              'UPDATE customers SET last_service_date = ?, next_reminder_date = ? WHERE id = ?'
            ).bind(today, nextDateStr, reqRow.customer_id).run();
          }
        }

        await logAudit(env, authUser.admin_id, 'UPDATE_REQUEST', 'service_requests', id, body);
        return successResponse({ updated: true });
      }
    }

    if (path === '/api/reminders/settings') {
      const res = await env.DB.prepare('SELECT * FROM reminder_settings ORDER BY id ASC').all();
      return successResponse(res.results || []);
    }

    if (path.startsWith('/api/reminders/settings/') && method === 'PUT') {
      const id = parseInt(path.split('/')[4]);
      const body = await request.json();
      await env.DB.prepare(
        'UPDATE reminder_settings SET name = coalesce(?, name), interval_days = coalesce(?, interval_days), message_template = coalesce(?, message_template), updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind(body.name, body.interval_days, body.message_template, id).run();
      await logAudit(env, authUser.admin_id, 'UPDATE_REMINDER_SETTING', 'reminder_settings', id, body);
      return successResponse({ updated: true });
    }

    if (path === '/api/reminders/logs') {
      const res = await env.DB.prepare(
        `SELECT rl.*, c.name as customer_name, c.phone as customer_phone
         FROM reminder_logs rl
         JOIN customers c ON rl.customer_id = c.id
         ORDER BY rl.id DESC LIMIT 50`
      ).all();
      return successResponse(res.results || []);
    }

    if (path === '/api/reminders/trigger' && method === 'POST') {
      const dueCustomers = await env.DB.prepare(
        'SELECT * FROM customers WHERE next_reminder_date <= date("now") AND bot_enabled = 1'
      ).all();

      const setting = await env.DB.prepare('SELECT * FROM reminder_settings WHERE active = 1 LIMIT 1').first();
      let sentCount = 0;

      if (setting && dueCustomers.results) {
        for (const cust of dueCustomers.results) {
          const alreadySent = await env.DB.prepare(
            'SELECT id FROM reminder_logs WHERE customer_id = ? AND scheduled_date = date("now")'
          ).bind(cust.id).first();

          if (!alreadySent) {
            let msg = setting.message_template
              .replace('{{customer_name}}', cust.name || 'সম্মানিত গ্রাহক')
              .replace('{{days_since}}', setting.interval_days);

            const sendRes = await sendWhatsAppMessage(env, cust.phone, msg);
            await env.DB.prepare(
              'INSERT INTO reminder_logs (customer_id, reminder_setting_id, scheduled_date, sent_at, status) VALUES (?, ?, date("now"), CURRENT_TIMESTAMP, ?)'
            ).bind(cust.id, setting.id, sendRes.success ? 'sent' : 'failed').run();

            const nextDate = new Date();
            nextDate.setDate(nextDate.getDate() + setting.interval_days);
            await env.DB.prepare(
              'UPDATE customers SET next_reminder_date = ? WHERE id = ?'
            ).bind(nextDate.toISOString().split('T')[0], cust.id).run();

            sentCount++;
          }
        }
      }
      await logAudit(env, authUser.admin_id, 'TRIGGER_REMINDERS', 'reminder_logs', null, { sent_count: sentCount });
      return successResponse({ processed: sentCount });
    }

    if (path === '/api/bot-config') {
      const res = await env.DB.prepare('SELECT * FROM bot_flow_config ORDER BY id ASC').all();
      return successResponse(res.results || []);
    }

    if (path.startsWith('/api/bot-config/') && method === 'PUT') {
      const key = path.split('/')[3];
      const { value } = await request.json();
      if (!value) return errorResponse('Value required');
      await env.DB.prepare(
        'UPDATE bot_flow_config SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE key = ?'
      ).bind(value, authUser.admin_id, key).run();
      await logAudit(env, authUser.admin_id, 'UPDATE_BOT_CONFIG', 'bot_flow_config', null, { key, value });
      return successResponse({ updated: true });
    }

    if (path === '/api/audit-logs') {
      const res = await env.DB.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50').all();
      return successResponse(res.results || []);
    }

    return errorResponse('Endpoint not found', 'NOT_FOUND', 404);
  },

  async scheduled(event, env, ctx) {
    console.log('Running daily scheduled reminder job...');
    const dueCustomers = await env.DB.prepare(
      'SELECT * FROM customers WHERE next_reminder_date <= date("now") AND bot_enabled = 1'
    ).all();
    const setting = await env.DB.prepare('SELECT * FROM reminder_settings WHERE active = 1 LIMIT 1').first();
    if (setting && dueCustomers.results) {
      for (const cust of dueCustomers.results) {
        const alreadySent = await env.DB.prepare(
          'SELECT id FROM reminder_logs WHERE customer_id = ? AND scheduled_date = date("now")'
        ).bind(cust.id).first();
        if (!alreadySent) {
          const msg = setting.message_template
            .replace('{{customer_name}}', cust.name || 'সম্মানিত গ্রাহক')
            .replace('{{days_since}}', setting.interval_days);
          const sendRes = await sendWhatsAppMessage(env, cust.phone, msg);
          await env.DB.prepare(
            'INSERT INTO reminder_logs (customer_id, reminder_setting_id, scheduled_date, sent_at, status) VALUES (?, ?, date("now"), CURRENT_TIMESTAMP, ?)'
          ).bind(cust.id, setting.id, sendRes.success ? 'sent' : 'failed').run();
        }
      }
    }
  }
};
