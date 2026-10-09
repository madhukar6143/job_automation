// ==UserScript==
// @name       Tsenta Auto-Judge (Humanized + Shared GM Storage + Tier-2 Low-Fit Reject Log)
// @match      *://*.tsenta.com/*
// @grant      GM_xmlhttpRequest
// @grant      GM_setValue
// @grant      GM_getValue
// @grant      unsafeWindow
// @connect    api.groq.com
// @connect    generativelanguage.googleapis.com
// @connect    script.google.com
// @connect    script.googleusercontent.com
// @run-at     document-idle
// ==/UserScript==

(function () {
  'use strict';
// Console-callable webhook test — runs inside the sandbox so it can reach
  // GM_xmlhttpRequest. Usage:  jrTestLog()


  var SCRIPT_VERSION = "6.9-tier2lowfit";

  // ===== MODE TOGGLE =====
  var AUTO_ACTION_MODE = false;

  // Paste your Apps Script /exec URL here to log tier-2 low-fit PASSED jobs.
  // Leave the placeholder to disable logging entirely.
  var PASS_LOG_WEBHOOK = "PASTE_YOUR_APPS_SCRIPT_EXEC_URL_HERE";

  // Add your own API keys below. Never commit real keys.
  var API_POOL = [
    { provider: "groq",   key: "YOUR_GROQ_API_KEY_1",   url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b" },
    { provider: "groq",   key: "YOUR_GROQ_API_KEY_2",   url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b" },
    { provider: "groq",   key: "YOUR_GROQ_API_KEY_3",   url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b" },
    { provider: "gemini", key: "YOUR_GEMINI_API_KEY_1", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-3.1-flash-lite" },
    { provider: "gemini", key: "YOUR_GEMINI_API_KEY_2", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-3.1-flash-lite" }
  ];

  var RESUME = "Madhukar Eppalapelly, MEng Computer Science, University of Cincinnati (2025-2026). Full-stack + AI engineer. Python, Java, C++, JavaScript, SQL, TypeScript. Spring Boot, React, Node.js, Angular, Flask. TensorFlow, PyTorch, OpenAI API, NLP, Computer Vision. PostgreSQL, MongoDB, Kafka, Redis. Docker, Kubernetes, AWS, Azure. ~2 years combined full-stack + AI experience.";

  var BASE_DELAY_SEC = 10;

  var running = false;
  var autoStartDone = false;
  var lastActivityTime = Date.now();

  function dbg(tag, d){}

  // In-SESSION guard (resets on reload).
  var sessionDone = new Set();
  function getProcessedJobs(){ return sessionDone; }
  function markJobProcessed(title){ if(title) sessionDone.add(title); }

  // ============================================================
  //  SHARED PERSISTENT STORE — keep identical to the CSV script.
  // ============================================================
  var SEEN_KEY = "sr_seen_map";
  var TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  function normalizeUrl(url){
    if (!url) return "";
    try {
      var p = new URL(url);
      ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","oga","ref","source","fbclid","gclid"]
        .forEach(k=>p.searchParams.delete(k));
      var qs = p.searchParams.toString();
      var c = p.origin + p.pathname + (qs ? "?" + qs : "");
      return c.endsWith("/") ? c.slice(0,-1) : c;
    } catch(e){ return url.split('?')[0].replace(/\/+$/,""); }
  }

  function normTitle(t){
    return (t||"")
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/[-–—|,].*$/, "")
      .replace(/\b(remote|hybrid|onsite|contract|full[\s-]?time|part[\s-]?time|intern|internship)\b/g,"")
      .replace(/[^a-z0-9 ]/g,"")
      .replace(/\s+/g," ")
      .trim();
  }

  function getSeenMap(){
    try {
      var data = JSON.parse(GM_getValue(SEEN_KEY, "{}"));
      if (typeof data !== 'object' || data === null) return {};
      return data;
    } catch(e){ return {}; }
  }
  function saveSeenMap(mapObj){ GM_setValue(SEEN_KEY, JSON.stringify(mapObj)); }

  function pruneOldLogs(){
    var map = getSeenMap(), now = Date.now(), pruned = 0;
    Object.keys(map).forEach(function(k){
      if (now - map[k] > TTL_MS){ delete map[k]; pruned++; }
    });
    var keys = Object.keys(map);
    if (keys.length > 3000){
      keys.sort(function(a,b){ return map[a]-map[b]; })
          .slice(0, keys.length - 3000)
          .forEach(function(k){ delete map[k]; });
      pruned++;
    }
    if (pruned > 0) saveSeenMap(map);
  }
  pruneOldLogs(); // sweep on every reload

  // Tiered key:
  //  tier 1 — real deep link (path or query) → precise, cross-source
  //  tier 2 — bare domain only → domain + normalized title
  //  tier 3 — no usable link (tsenta url) → normalized title
  function seenKeyFor(link, title){
    if (link && link.indexOf("tsenta.com") === -1 && /^https?:/i.test(link)){
      var norm = normalizeUrl(link);
      try {
        var p = new URL(norm);
        var hasPath  = p.pathname && p.pathname !== "/" && p.pathname !== "";
        var hasQuery = p.search && p.search.length > 1;
        if (!hasPath && !hasQuery){
          return "co+title::" + p.origin + "::" + normTitle(title);
        }
      } catch(e){}
      return norm;
    }
    return "title::" + normTitle(title);
  }
  // True when the key is a tier-2/3 fallback (no unique URL identity).
  function isFallbackKey(link, title){
    var k = seenKeyFor(link, title);
    return k.indexOf("co+title::") === 0 || k.indexOf("title::") === 0;
  }
  function isPersisted(link, title){
    var map = getSeenMap();
    return Object.prototype.hasOwnProperty.call(map, seenKeyFor(link, title));
  }
  function markPersisted(link, title){
    var map = getSeenMap();
    var key = seenKeyFor(link, title);
    if (map[key]) return; // keep original first-seen timestamp
    map[key] = Date.now();
    saveSeenMap(map);
  }

  // ===== Console helpers (attached to the PAGE window via unsafeWindow) =====
  unsafeWindow.resetAutoJudgeHistory = function(){
    sessionDone.clear();
    GM_setValue(SEEN_KEY, "{}");
  };
  unsafeWindow.getJrStorage = function(){ return getSeenMap(); };
  unsafeWindow.jrLast = function(n){
    n = n || 5;
    var map = getSeenMap();
    var rows = Object.keys(map)
      .map(function(k){ return { key: k, ts: map[k], when: new Date(map[k]).toLocaleString() }; })
      .sort(function(a,b){ return b.ts - a.ts; })
      .slice(0, n);
    console.table(rows);
    return rows;
  };

  // Logs a job to the Google Sheet. Called only for tier-2 low-fit PASSED jobs below.
  function logToGoogleSheet(data){
    if(!PASS_LOG_WEBHOOK || PASS_LOG_WEBHOOK.indexOf("PASTE_") === 0) return;
    GM_xmlhttpRequest({
      method:"POST", url:PASS_LOG_WEBHOOK,
      headers:{"Content-Type":"application/json"},
      data:JSON.stringify(data),
      onload:function(){}, onerror:function(){}
    });
  }

  // --- UI ---
  var startBtn = document.createElement("button");
  startBtn.textContent = "▶ Auto-judge v" + SCRIPT_VERSION;
  startBtn.style.cssText = "position:fixed;bottom:24px;left:24px;z-index:999999;background:#111827;color:#fff;border:none;padding:12px 16px;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.3);";
  document.body.appendChild(startBtn);

  var modeBtn = document.createElement("button");
  function modeLabel(){ return AUTO_ACTION_MODE ? "⚙️ Mode: AUTO (click→MANUAL)" : "✋ Mode: MANUAL (click→AUTO)"; }
  modeBtn.textContent = modeLabel();
  modeBtn.style.cssText = "position:fixed;bottom:24px;left:250px;z-index:999999;background:#374151;color:#fff;border:none;padding:12px 16px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.3);";
  modeBtn.onclick = function(){
    AUTO_ACTION_MODE = !AUTO_ACTION_MODE;
    modeBtn.textContent = modeLabel();
    if(!AUTO_ACTION_MODE){
      running = false;
      startBtn.textContent = "▶ Auto-judge v" + SCRIPT_VERSION;
      manualLastTitle = "";
      say("✋ MANUAL mode — open any job yourself; I'll judge it and badge it. I won't open or click anything.");
    } else {
      say("⚙️ AUTO mode — press ▶ to let me judge and click through jobs.");
    }
  };
  document.body.appendChild(modeBtn);

  var status = document.createElement("div");
  status.style.cssText = "position:fixed;bottom:72px;left:24px;z-index:999999;background:#111827;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;max-width:380px;display:none;line-height:1.5;";
  document.body.appendChild(status);
  function say(t){ status.style.display="block"; status.innerHTML=t; }

  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function randomBetween(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
  function jitterSleep(base,varr){ return sleep(randomBetween(Math.max(100,base-varr),base+varr)); }

  async function humanScrollTo(el){ if(!el)return; el.scrollIntoView({behavior:"smooth",block:"center"}); await jitterSleep(400,150); }

  async function clickReact(el){
    if(!el) return false;
    await humanScrollTo(el);
    await jitterSleep(150,50);
    try{ el.focus(); }catch(e){}
    el.click();
    return true;
  }

  function extractJSON(s){
    if(!s)return null;
    try{return JSON.parse(s);}catch(e){}
    var clean=s.replace(/```json/gi,"").replace(/```/g,"").replace(/[“”]/g,'"').trim();
    try{return JSON.parse(clean);}catch(e){}
    var m=clean.match(/\{[\s\S]*\}/);
    if(m){try{return JSON.parse(m[0]);}catch(e){var f=m[0].replace(/,\s*([\}\]])/g,"$1");try{return JSON.parse(f);}catch(e2){}}}
    return null;
  }

  function findBtn(root, re){
    if(!root)return null;
    var all = Array.from(root.querySelectorAll("button,[role='button']"))
      .filter(b => re.test((b.innerText || b.getAttribute("aria-label") || "").trim()));
    if(all.length===0) return null;
    return all[0];
  }

  function getCards(){
    var matched=Array.from(document.querySelectorAll("div")).filter(c=>{
      var t=c.innerText||"";
      if(/add your own link|add link|quick apply/i.test(t)) return false;
      return c.querySelector("h3")!==null && /Details/i.test(t) && /Apply/i.test(t) && /Pass/i.test(t) && t.length>50 && t.length<2500;
    });
    matched.sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
    var seen={}, out=[];
    matched.forEach(c=>{
      var h=c.querySelector("h3"); var tt=h?h.innerText.trim():null;
      if(!tt || seen[tt]) return;
      seen[tt]=1; out.push(c);
    });
    return out;
  }

  function openPanel(){
    var ps=Array.from(document.querySelectorAll('div[class*="fixed"]')).filter(p=>/right-0|inset-y/.test(p.className)&&p.querySelector("h1,h2"));
    ps.sort((a,b)=>b.innerText.length-a.innerText.length);
    return ps[0]||null;
  }

  function extractCompany(card,panel){
    var container=panel||card; if(!container)return"Unknown";
    var h3=container.querySelector("h3");
    if(h3&&h3.nextElementSibling){var text=h3.nextElementSibling.innerText.trim();if(text)return text.split("\n")[0];}
    var els=Array.from(container.querySelectorAll("p,span,div"));
    for(var el of els){var txt=el.innerText.trim();if(txt&&txt.length<50&&!/Details|Apply|Pass|Save|Not interested/i.test(txt))return txt;}
    return "Unknown";
  }

  function extractJobLink(card,panel){
    var container=panel||card||document, links=Array.from(container.querySelectorAll("a[href]"));
    var ext=links.find(a=>a.href.startsWith("http")&&!a.href.includes("tsenta.com"));if(ext)return ext.href;
    var intl=links.find(a=>a.href.includes("/job/"));if(intl)return intl.href;
    return window.location.href;
  }

  function parseYears(raw){
    if(typeof raw==="number"&&isFinite(raw))return Math.round(raw);
    if(typeof raw==="string"){var m=raw.match(/\d+/);if(m)return parseInt(m[0],10);}
    return NaN;
  }

    var SCH={name:"screen",strict:true,schema:{type:"object",additionalProperties:false,
 required:["decision","fit","reason","yearsRequired","citizenshipOrClearance"],
 properties:{
  decision:{type:"string",enum:["APPLY","PASS"]},
  fit:{type:"integer",minimum:0,maximum:100},
  reason:{type:"string"},
  yearsRequired:{type:["integer","null"]},
  citizenshipOrClearance:{type:"string",enum:["required","not stated"]}}}};

function payload(t,sys,usr){
  var b={model:t.model,temperature:0,max_tokens:1200,
    messages:[{role:"system",content:sys},{role:"user",content:usr}]};
  if(/gpt-oss/.test(t.model)){
    b.reasoning_effort="low"; b.include_reasoning=false;
    b.response_format={type:"json_schema",json_schema:SCH};
  } else b.response_format={type:"json_object"};
  return b;
}

  // ===== JUDGING =====
  function judge(jd, jobTitle){
    return new Promise(resolve=>{
      var hard=/(security|secret|government|top\s+secret)\s+clearance|ts\/sci|\bitar\b|\bear\b\s+regulations|export\s+administration\s+regulations|export[\s-]control(s|led)?\b|\bu\.?s\.?\s+persons?\b|must\s+be\s+(a\s+)?u\.?s\.?\s+citizen|u\.?s\.?\s+citizenship\s+(is\s+)?required|u\.?s\.?\s+citizens?\s+only/i.test(jd||"");
      if(hard){
        return resolve({decision:"PASS",fit:0,reason:"Defense/export-restricted posting — cannot apply",yearsRequired:"unknown",citizenshipOrClearance:"required"});
      }

      var SENIOR_TITLE = /\b(senior|sr|staff|principal|lead|architect|advisor|manager|director|head|vp|distinguished)\b/i;
      if (SENIOR_TITLE.test(jobTitle || "")) {
        return resolve({
          decision: "PASS",
          fit: 0,
          reason: "Senior-level title — auto-passed",
          yearsRequired: "unknown",
          citizenshipOrClearance: "not stated"
        });
      }

      var target=API_POOL[Math.floor(Math.random()*API_POOL.length)];
      var maxChars=target.provider==="groq"?10000:12000;
      var cleanJD=jd?jd.substring(0,maxChars):"";
      var attempts=0;

      var sys="You are an automated job screener. You MUST respond with ONLY valid JSON and no extra conversational text.";
      var usr="Screen this job for the user.\n\nRULES:\n1. citizenshipOrClearance='required' ONLY if the job EXPLICITLY demands US citizen / US person / security clearance. EEO statements, protected veterans, ADA, GDPR/CCPA, and work-authorization questions do NOT count => 'not stated'.\n2. yearsRequired = MINIMUM years explicitly required, plain integer ('3-5 years'=>3, '6+'=>6). If not stated, null. NEVER words.\n3. Ignore visa sponsorship entirely.\n4. fit (0-100) by resume alignment with required skills AND domain. Be strict: a different stack/domain lowers fit a lot.\n5. reason: ONE short sentence consistent with the decision. If you mention a blocker in the reason, decision MUST be PASS. Never mention citizenship if the job does not require it.\n6. Return ONLY:\n{\"decision\":\"APPLY or PASS\",\"fit\":80,\"reason\":\"...\",\"yearsRequired\":3,\"citizenshipOrClearance\":\"required or not stated\"}\n\nRESUME:\n"+RESUME+"\n\nJOB DESCRIPTION:\n"+cleanJD;

      function call(){
        GM_xmlhttpRequest({
          method:"POST", url:target.url,
          headers:{"Content-Type":"application/json","Authorization":"Bearer "+target.key},
            data:JSON.stringify(payload(target,sys,usr)),
          onload:async function(r){
            if(r.status===429&&attempts<3){attempts++;await sleep(10000);call();return;}
            try{
              var resp=JSON.parse(r.responseText), raw=resp.choices[0].message.content, d=extractJSON(raw)||{};
              var n={};for(var k in d)n[k.toLowerCase()]=d[k];

              var jdClear=/(security\s+clearance|u\.?s\.?\s+citizen|citizenship\s+(is\s+)?required|\bus\s+persons?\b|\bitar\b|export[\s-]control|government\s+clearance|secret\s+clearance|ts\/sci)/i.test(jd||"");
              var jdYears=/\d+\s*\+?\s*(?:-|to|–)?\s*\d*\s*(?:\+\s*)?years?/i.test(jd||"");

              var py=parseYears(n.yearsrequired);
              var clr=String(n.citizenshiporclearance||"").toLowerCase().trim();
              var isClear=clr==="required"&&jdClear;
              var fit=typeof n.fit==="number"?n.fit:(parseInt(n.fit,10)||0);
              var lr=String(n.reason||"").trim();
              if(!jdClear&&/clearance|citizen|us person/i.test(lr))lr="";

              var decision,reason;
              if(isClear){decision="PASS";reason="Citizenship/clearance restriction stated"+(lr?" — "+lr:"");}
              else if(!isNaN(py)&&py>6&&jdYears){decision="PASS";reason="Requires "+py+"+ yrs (limit 6)"+(lr?" — "+lr:"");}
              else if(fit<=80){decision="PASS";reason="Fit "+fit+"% below cutoff"+(lr?" — "+lr:"");}
              else {decision="APPLY";reason=lr||("Strong fit: "+fit+"%");}

              resolve({decision:decision,fit:fit,reason:reason,yearsRequired:!isNaN(py)?py:"unknown",citizenshipOrClearance:isClear?"required":"not stated"});
            }catch(e){
              resolve({decision:"PASS",fit:0,reason:"JSON parse error",yearsRequired:"unknown",citizenshipOrClearance:"not stated"});
            }
          },
          onerror:function(){ resolve({decision:"PASS",fit:0,reason:"API request failed",yearsRequired:"unknown",citizenshipOrClearance:"not stated"}); }
        });
      }
      call();
    });
  }

  // ===== MAIN LOOP =====
  async function runLoop(){
    if(!AUTO_ACTION_MODE){
      say("✋ MANUAL mode — open any job yourself; I'll judge it and show the verdict. I won't open or click anything.");
      running=false;
      startBtn.textContent="▶ Auto-judge v"+SCRIPT_VERSION;
      return;
    }
    var applied=0, saved=0, passed=0, count=0, consecutiveMisses=0;
    say("Starting… (always processes the first unprocessed job)");
    await jitterSleep(1000,300);

    while(running){
      var cards=getCards();
      var seen={}, unique=[];
      for(var c of cards){
        var hh=c.querySelector("h3"); var tt=hh?hh.innerText.trim():null;
        if(!tt || seen[tt]) continue;
        seen[tt]=1; unique.push({card:c,title:tt});
      }
      var processedSet=getProcessedJobs();
      var next=unique.find(u=>{
        if(processedSet.has(u.title)) return false;
        if(/add your own link|add link|quick apply/i.test(u.title)) return false;
        if(isPersisted(null, u.title)) return false;
        return true;
      });

      if(!next){
        consecutiveMisses++;
        if(/no more jobs to show/i.test(document.body.innerText) || consecutiveMisses>3){
          break;
        }
        say("⏳ Waiting for feed…");
        await sleep(3000);
        continue;
      }
      consecutiveMisses=0;

      var card=next.card, title=next.title;

      var detailsBtn=findBtn(card,/Details/i);
      if(!detailsBtn){ markJobProcessed(title); continue; }

      await clickReact(detailsBtn);
      await jitterSleep(1200,300);

      var panel=openPanel();
      var panelH=panel?panel.querySelector("h1,h2,h3"):null;
      var panelTitle=panelH?panelH.innerText.trim():"";
      var titleMatches = panel && panelTitle && (panelTitle.toLowerCase().indexOf(title.toLowerCase().slice(0,15))>-1 || title.toLowerCase().indexOf(panelTitle.toLowerCase().slice(0,15))>-1);
      if(!titleMatches){
        markJobProcessed(title);
        var cbx=findBtn(document,/^Close$/i)||Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="Close"||/^[×x]$/.test(b.innerText.trim()));
        if(cbx)await clickReact(cbx);
        await jitterSleep(600,150);
        continue;
      }

      var jobText=panel.innerText;
      var companyName=extractCompany(card,panel);
      var jobLink=extractJobLink(card,panel);

      if(isPersisted(jobLink, title)){
        markJobProcessed(title);
        var cbx2=findBtn(document,/^Close$/i)||Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="Close"||/^[×x]$/.test(b.innerText.trim()));
        if(cbx2)await clickReact(cbx2);
        await jitterSleep(600,150);
        continue;
      }

      count++;
      say(`#${count} Judging: ${title}`);
      markJobProcessed(title);
      markPersisted(jobLink, title);
      lastActivityTime=Date.now();

      var v=await judge(jobText, title);

      // Log ONLY tier-2/3 fallback jobs PASSED for LOW FIT — the borderline
      // calls worth a human glance. Clearance/citizenship/seniority/export/
      // error passes are never actionable, so they're kept OUT of the sheet.
      if(v.decision!=="APPLY"
         && isFallbackKey(jobLink, title)
         && /fit\s+\d+%\s+below\s+cutoff/i.test(v.reason)){
        logToGoogleSheet({title:title, company:companyName, jobLink:jobLink, fit:v.fit, reason:v.reason});
      }

      var readingDelay=Math.min(Math.max(jobText.length,1000),BASE_DELAY_SEC*1000*0.3);
      await jitterSleep(readingDelay,300);

      if(AUTO_ACTION_MODE){
        say(v.decision==="APPLY"?`✅ APPLY: ${title} (fit ${v.fit})<br><span style='opacity:.7'>Applying…</span>`:`❌ PASS: ${title} (${v.reason})<br><span style='opacity:.7'>Saving/Passing…</span>`);
        await jitterSleep(800,200);
      }

      if(v.decision==="APPLY"){
        var applyBtn=findBtn(panel,/^Apply$/i);
        if(applyBtn){ await clickReact(applyBtn); applied++; }
        await jitterSleep(1000,250);
      } else {
        var saveBtn=findBtn(panel,/Save/i);
        if(saveBtn){ await clickReact(saveBtn); saved++; await jitterSleep(800,200); }
        var tnorm=title.toLowerCase().replace(/\s+/g," ").trim().slice(0,30);
        var passBtn=Array.from(document.querySelectorAll('button[aria-label]')).find(b=>{
          var al=(b.getAttribute("aria-label")||"").toLowerCase();
          return /^not interested in/.test(al) && al.indexOf(tnorm)>-1;
        }) || findBtn(panel,/Not interested|^Pass$/i);
        if(passBtn){ await clickReact(passBtn); passed++; }
      }

      var closeBtn=findBtn(document,/^Close$/i)||Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="Close"||/^[×x]$/.test(b.innerText.trim()));
      if(closeBtn)await clickReact(closeBtn);
      for(var dc=0; dc<12; dc++){
        if(!openPanel()) break;
        if(dc===3){
          var cb2=findBtn(document,/^Close$/i)||Array.from(document.querySelectorAll("button")).find(b=>(b.getAttribute("aria-label")||"").toLowerCase().indexOf("close")>-1);
          if(cb2) await clickReact(cb2);
          document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",keyCode:27,bubbles:true}));
        }
        await sleep(250);
      }
      await jitterSleep(600,150);

      if(v.decision!=="APPLY"){
        var tnorm2=title.toLowerCase().replace(/\s+/g," ").trim().slice(0,30);
        for(var pr=0; pr<3; pr++){
          var stillCard=getCards().find(c=>{var hh=c.querySelector("h3");return hh&&hh.innerText.trim()===title;});
          if(!stillCard) break;
          var cardPass=Array.from(document.querySelectorAll('button[aria-label]')).find(b=>{
            var al=(b.getAttribute("aria-label")||"").toLowerCase();
            return /^not interested in/.test(al) && al.indexOf(tnorm2)>-1;
          }) || findBtn(stillCard,/^Pass$/i);
          if(cardPass){ await clickReact(cardPass); await jitterSleep(900,200); }
          else { break; }
        }
      }

      say(`${v.decision==="APPLY"?"✅ APPLIED":"❌ PASSED"}: ${title}<br>Applied ${applied} | Saved ${saved} | Passed ${passed}`);

      if(running){
        var waitSecs=randomBetween(Math.max(5,BASE_DELAY_SEC),Math.round(BASE_DELAY_SEC*1.5));
        if(count>0 && count%randomBetween(4,6)===0){
          waitSecs+=Math.round(BASE_DELAY_SEC*2);
          say(`☕ Human break (${Math.round(waitSecs)}s)…<br>Applied ${applied} | Saved ${saved} | Passed ${passed}`);
        } else {
          say(`Waiting ~${waitSecs}s…<br>Applied ${applied} | Saved ${saved} | Passed ${passed}`);
        }
        await sleep(waitSecs*1000);
      }
    }

    if(applied===0 && saved===0 && passed===0){
      say("No actionable jobs found. Waiting 2 min for feed to refresh…");
      await sleep(120000);
      location.reload();
    } else {
      say(`Done batch! ✅ ${applied} | 💾 ${saved} | ❌ ${passed}. Refreshing in 10s…`);
      await sleep(10000);
      location.reload();
    }
  }

  // ===== MANUAL MODE OBSERVER =====
  var manualLastTitle = "";
  var manualBusy = false;

  function renderManualBadge(panel, v){
    if(!panel) return;
    var old = panel.querySelector("#ai-manual-badge"); if(old) old.remove();
    var isApply = v.decision==="APPLY";
    var wrap = document.createElement("div");
    wrap.id = "ai-manual-badge";
    wrap.style.cssText = `margin:12px 0;padding:8px 14px;border-radius:12px;font-size:13px;font-weight:600;text-align:center;background:${isApply?"#f0fdf4":"#fef2f2"};color:${isApply?"#166534":"#991b1b"};border:1px solid ${isApply?"#86efac":"#fca5a5"};`;
    wrap.innerHTML = `${isApply?"✅":"❌"} <b>${v.decision}</b> (fit ${v.fit}%) — ${v.reason}<br><span style="font-weight:400;opacity:.7;font-size:11px;">AI suggestion — you decide. Click Apply or Pass yourself.</span>`;
    var h = panel.querySelector("h1,h2,h3");
    if(h) h.insertAdjacentElement("afterend", wrap); else panel.prepend(wrap);
  }

  var manualObserver = new MutationObserver(async function(){
    if(AUTO_ACTION_MODE || running || manualBusy) return;
    var panel = openPanel();
    if(!panel) return;
    var h = panel.querySelector("h1,h2,h3");
    var title = h ? h.innerText.trim() : "";
    if(!title || title===manualLastTitle) return;
    var jobText = panel.innerText;
    if(jobText.length < 100) return;

    manualBusy = true;
    manualLastTitle = title;
    try{
      renderManualBadge(panel, {decision:"…",fit:"",reason:"judging…"});
      var v = await judge(jobText, title);
      renderManualBadge(panel, v);
    } finally {
      manualBusy = false;
    }
  });
  manualObserver.observe(document.body, {childList:true, subtree:true});

  startBtn.onclick=function(){
    if(running){ running=false; startBtn.textContent="▶ Auto-judge v"+SCRIPT_VERSION; return; }
    running=true; lastActivityTime=Date.now(); startBtn.textContent="⏳ v"+SCRIPT_VERSION+" Running… (stop)"; runLoop();
  };

  function autoStart(){
    if(!AUTO_ACTION_MODE) return;
    if(!autoStartDone && location.pathname.includes("/dashboard/recommendations")){
      autoStartDone=true; setTimeout(()=>startBtn.click(), randomBetween(1500,3000));
    }
  }
  setTimeout(autoStart,1000);

  var ops=history.pushState;
  history.pushState=function(){ ops.apply(history,arguments); autoStartDone=false; setTimeout(autoStart,randomBetween(1000,2000)); };

  setInterval(function(){
    if(AUTO_ACTION_MODE && location.pathname.includes("/dashboard/recommendations")){ location.reload(); }
  }, randomBetween(15*60*1000,20*60*1000));

  setInterval(function(){
    if(AUTO_ACTION_MODE && running && (Date.now()-lastActivityTime>8*60*1000)){ location.reload(); }
  }, 60*1000);

  setInterval(function () {
    console.log("AUTO STATUS:","running=" + running,"cards=" + getCards().length,"hidden=" + document.hidden,"focus=" + document.hasFocus(),new Date().toLocaleTimeString());
  }, 5000);

})();
