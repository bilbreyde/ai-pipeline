(function(){
"use strict";
var STAGES=["Identified","Discovery","Qualified","Proposal / RFP","Blocked","Won","Lost"];
var OPEN=["Identified","Discovery","Qualified","Proposal / RFP","Blocked"];
var SEGMENTS=["ITS","ENT","MM","Healthcare","SLED / Public Sector Utility"];
var LEADS=["Zones","Thoughtworks"];
var TW=["Engaged","Strong fit","Target","Potential","Not indicated","Zones only"];
var DEFAULTS={marginBasis:"price",defaultGm:30,probs:{"Identified":5,"Discovery":10,"Qualified":25,"Proposal / RFP":50,"Blocked":10,"Won":100,"Lost":0}};
var COLS=[
  {k:"account",l:"Account"},{k:"stage",l:"Stage"},{k:"seller",l:"Seller / lead"},
  {k:"size",l:"Deal size",num:1},{k:"margin",l:"Est. margin",num:1},{k:"weighted",l:"Weighted",num:1},
  {k:"next",l:"Next step",ns:1},{k:"close",l:"Close"},{k:"updated",l:"Updated"}
];
var S={canWrite:true,me:"",bulk:false,ai:false,aiWhy:"",aiDemo:false,tab:"pipeline",loaded:false,offline:false,err:"",opps:[],settings:clone(DEFAULTS),
  sellers:{},sort:{k:"margin",d:"desc"},f:{q:"",stage:"all",lead:"",seg:"",gaps:false},editing:null,delArmed:false};
var chains={};

function $(id){return document.getElementById(id)}
function clone(o){return JSON.parse(JSON.stringify(o))}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
var DC=window.DashCalc;
function isOpen(o){return DC.isOpen(o)}
function full(n){return n==null?"":"$"+Math.round(n).toLocaleString("en-US")}
function compact(n){
  if(n==null)return "–";
  if(Math.abs(n)>=1e6)return "$"+(n/1e6).toFixed(2)+"M";
  if(Math.abs(n)>=1e3)return "$"+Math.round(n/1e3)+"K";
  return "$"+Math.round(n);
}
function parseMoney(s){
  s=String(s||"").trim().toLowerCase().replace(/[$,\s]/g,"");
  if(!s)return null;
  var m=1; if(/k$/.test(s)){m=1e3;s=s.slice(0,-1)} else if(/m$/.test(s)){m=1e6;s=s.slice(0,-1)}
  var n=parseFloat(s); return isFinite(n)?Math.round(n*m):NaN;
}
function gmOf(o){return DC.gmOf(o,S.settings)}
function marginOf(o){return DC.marginOf(o,S.settings)}
function probOf(o){return DC.probOf(o,S.settings)}
function weightedOf(o){return DC.weightedOf(o,S.settings)}
function gapsOf(o){return DC.gapsOf(o)}
function todayStart(){var d=new Date();d.setHours(0,0,0,0);return d}
function parseDate(s){if(!s)return null;var d=new Date(s+"T00:00:00");return isNaN(d)?null:d}
function fmtDate(d){return d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:d.getFullYear()===new Date().getFullYear()?undefined:"numeric"})}
function daysAgo(iso){if(!iso)return null;var t=Date.parse(iso);if(isNaN(t))return null;return Math.floor((Date.now()-t)/864e5)}
/* Seller field on a row is free text, so match the saved directory by name, not exact string. */
function sellerKey(n){return String(n||"").trim().toLowerCase()}
function sellerEmail(name){
  var k=sellerKey(name);if(!k)return null;
  for(var n in S.sellers){if(Object.prototype.hasOwnProperty.call(S.sellers,n)&&sellerKey(n)===k)return S.sellers[n]}
  return null;
}

/* ---------- toast ---------- */
var toastT;
function toast(msg,err){
  var t=$("toast");t.textContent=msg;t.className=err?"err":"";t.hidden=false;
  clearTimeout(toastT);toastT=setTimeout(function(){t.hidden=true},err?5000:2200);
}
function errMsg(e){
  if(e&&e.details&&e.details.length)return e.details.join(" ");
  return (e&&e.message)||"Save failed. Try again.";
}

/* ---------- api ---------- */
function api(method,url,body){
  var opt={method:method,headers:{"Accept":"application/json"},credentials:"same-origin"};
  if(body!==undefined){opt.headers["Content-Type"]="application/json";opt.body=JSON.stringify(body)}
  return fetch(url,opt).then(function(r){
    return r.text().then(function(t){
      var data=null;try{data=t?JSON.parse(t):null}catch(e){}
      if(!r.ok){
        var err=new Error((data&&data.error)||("Request failed ("+r.status+")"));
        err.status=r.status;err.details=data&&data.details;throw err;
      }
      return data;
    });
  });
}
function queued(key,fn){var p=(chains[key]||Promise.resolve()).catch(function(){}).then(fn);chains[key]=p;return p}
function upsertLocal(item){
  for(var i=0;i<S.opps.length;i++){if(S.opps[i].id===item.id){S.opps[i]=item;return}}
  S.opps.push(item);
}
function saveOpp(id,patch){
  return queued("opps/"+id,function(){return api("PATCH","/api/opps/"+encodeURIComponent(id),patch)})
    .then(function(r){upsertLocal(r.item);render(true);return true},
          function(e){toast(errMsg(e),true);renderTable();return false});
}
function addOpp(data){
  return api("POST","/api/opps",data)
    .then(function(r){upsertLocal(r.item);render(true);return true},
          function(e){toast(errMsg(e),true);return false});
}
function delOpp(id){
  return queued("opps/"+id,function(){return api("DELETE","/api/opps/"+encodeURIComponent(id))})
    .then(function(){S.opps=S.opps.filter(function(x){return x.id!==id});render(true);return true},
          function(e){toast(errMsg(e),true);return false});
}
var settingsT,settingsDirty=false;
function saveSettings(){
  var probs={};
  STAGES.forEach(function(s,i){var v=parseFloat($("p-"+i).value);probs[s]=isFinite(v)?Math.min(100,Math.max(0,v)):0});
  var gm=parseFloat($("defGm").value);
  var next={marginBasis:$("basisCost").checked?"cost":"price",defaultGm:isFinite(gm)?Math.min(90,Math.max(1,gm)):30,probs:probs};
  S.settings=next;settingsDirty=true;render(true);
  clearTimeout(settingsT);
  settingsT=setTimeout(function(){
    queued("settings",function(){return api("PUT","/api/settings",next)})
      .then(function(){settingsDirty=false},function(e){settingsDirty=false;toast(errMsg(e),true)});
  },500);
}

/* ---------- derived ---------- */
function filtered(){
  var f=S.f,q=f.q.trim().toLowerCase();
  var rows=S.opps.filter(function(o){
    if(f.stage==="open"&&!isOpen(o))return false;
    if(f.stage!=="all"&&f.stage!=="open"&&o.stage!==f.stage)return false;
    if(f.lead&&(o.lead||"")!==(f.lead==="_none"?"":f.lead))return false;
    if(f.seg&&(o.segment||"")!==f.seg)return false;
    if(f.gaps&&!gapsOf(o).length)return false;
    if(q){var hay=[o.account,o.opportunity,o.seller,o.nextStep,o.notes].join(" ").toLowerCase();if(hay.indexOf(q)<0)return false}
    return true;
  });
  var k=S.sort.k,dir=S.sort.d==="asc"?1:-1;
  function val(o){
    switch(k){
      case "account":return (o.account||"").toLowerCase();
      case "stage":return STAGES.indexOf(o.stage);
      case "seller":return (o.seller||"").toLowerCase();
      case "size":return o.size==null?null:o.size;
      case "margin":return marginOf(o);
      case "weighted":return weightedOf(o);
      case "next":return (o.nextStep||"").toLowerCase();
      case "close":return o.closeDate||null;
      case "updated":return o.updatedAt||null;
    }
  }
  rows.sort(function(a,b){
    var x=val(a),y=val(b);
    if(x==null&&y==null)return (a.account||"").localeCompare(b.account||"");
    if(x==null)return 1; if(y==null)return -1;
    if(x<y)return -1*dir; if(x>y)return 1*dir;
    return (a.account||"").localeCompare(b.account||"");
  });
  return rows;
}

/* ---------- render ---------- */
function renderBand(){
  var open=S.opps.filter(isOpen),sized=open.filter(function(o){return o.size!=null});
  var size=0,mar=0,wt=0;
  sized.forEach(function(o){size+=o.size;mar+=marginOf(o)||0;wt+=weightedOf(o)||0});
  var noSeller=open.filter(function(o){return !o.seller}).length;
  var unsized=open.length-sized.length;
  var gapRows=open.filter(function(o){return gapsOf(o).length}).length;
  var basisTxt=S.settings.marginBasis==="cost"?"cost basis":"sell price basis";
  $("band").innerHTML=
    '<div class="metric"><span class="m-label">Open deal size</span><span class="m-val">'+compact(size)+'</span><span class="m-note">'+open.length+' open opportunities</span></div>'+
    '<div class="metric"><span class="m-label">Est. margin</span><span class="m-val">'+compact(mar)+'</span><span class="m-note">at '+S.settings.defaultGm+'% GM default, '+basisTxt+'</span></div>'+
    '<div class="metric"><span class="m-label">Weighted margin</span><span class="m-val">'+compact(wt)+'</span><span class="m-note">by stage win probability</span></div>'+
    '<div class="metric'+(gapRows?' flag':'')+'"><span class="m-label">Rows with gaps</span><span class="m-val">'+gapRows+' of '+open.length+'</span><span class="m-note"><b>'+unsized+'</b> without a size, <b>'+noSeller+'</b> without a seller</span></div>';
}
function renderInsights(){
  var open=S.opps.filter(isOpen);
  var byStage=OPEN.map(function(st){
    var items=open.filter(function(o){return o.stage===st}),m=0,uns=0;
    items.forEach(function(o){var v=marginOf(o);if(v==null)uns++;else m+=v});
    return {st:st,n:items.length,m:m,uns:uns};
  });
  var max=Math.max.apply(null,byStage.map(function(b){return b.m}).concat([1]));
  $("stageBars").innerHTML=byStage.map(function(b){
    var meta=b.n?(b.n+(b.n===1?" deal":" deals")+(b.uns?", "+b.uns+" unsized":"")):"No deals";
    return '<div class="brow"><span class="nm">'+esc(b.st)+'</span><span class="track"><i style="width:'+(b.m/max*100).toFixed(1)+'%"></i></span><span class="val">'+(b.n&&b.m===0?"–":compact(b.m))+'</span><span class="meta">'+meta+'</span></div>';
  }).join("");

  var sized=open.filter(function(o){return marginOf(o)!=null}).sort(function(a,b){return marginOf(b)-marginOf(a)});
  var total=sized.reduce(function(s,o){return s+marginOf(o)},0);
  var top=sized.slice(0,5);
  $("concBars").innerHTML=top.length?top.map(function(o){
    var sh=total?marginOf(o)/total:0;
    return '<div class="brow"><span class="nm" title="'+esc(o.account)+'">'+esc(o.account)+'</span><span class="track"><i style="width:'+(sh*100).toFixed(1)+'%"></i></span><span class="val">'+Math.round(sh*100)+'%</span></div>';
  }).join(""):'<div class="empty" style="padding:12px 0;text-align:left">Add deal sizes to see concentration.</div>';
  var alert="";
  if(top.length){
    var t=top[0],sh=marginOf(t)/total;
    if(sh>=0.35){
      alert='<p class="alert"><b>'+esc(t.account)+'</b> is '+Math.round(sh*100)+'% of estimated margin. '+
        (t.gmPct==null?'It is using the '+S.settings.defaultGm+'% default GM. If its real margin is lower, every total on this page is overstated. Set GM% on that row.':'Its GM% is set to '+gmOf(t)+'%. Confirm that figure before quoting the total.')+'</p>';
    }
  }
  $("concAlert").innerHTML=alert;
}
function stagePill(o){
  var dis=S.canWrite?"":" disabled";
  return '<span class="pill-wrap" data-stage="'+esc(o.stage)+'"><select class="stage-sel" data-id="'+esc(o.id)+'" aria-label="Stage for '+esc(o.account)+'"'+dis+'>'+
    STAGES.map(function(s){return '<option'+(s===o.stage?' selected':'')+'>'+esc(s)+'</option>'}).join("")+'</select></span>';
}
function renderHead(){
  $("thead").innerHTML=COLS.map(function(c){
    var on=S.sort.k===c.k,aria=on?(S.sort.d==="asc"?"ascending":"descending"):"none";
    return '<th class="'+(c.num?"num":"")+'" aria-sort="'+aria+'"><button class="th" type="button" data-sort="'+c.k+'">'+c.l+'</button></th>';
  }).join("");
}
function renderTable(){
  var rows=filtered(),tb=$("tbody"),today=todayStart();
  if(!S.loaded){
    tb.innerHTML='<tr><td colspan="9"><div class="empty">'+(S.offline?"Can't reach the pipeline service yet.":"Loading pipeline")+'</div></td></tr>';
    $("tfoot").innerHTML="";$("count").textContent="";return;
  }
  if(!rows.length){
    tb.innerHTML='<tr><td colspan="9"><div class="empty">'+(S.opps.length?"No opportunities match these filters.":"No opportunities yet. Use Add opportunity, or Import to load a spreadsheet.")+'</div></td></tr>';
  }else{
    tb.innerHTML=rows.map(function(o){
      var m=marginOf(o),w=weightedOf(o),gaps=gapsOf(o);
      var tags=gaps.map(function(g){return '<span class="tag">'+g+'</span>'}).join("");
      if(o.tw==="Engaged"||o.tw==="Strong fit"||o.tw==="Target")tags+='<span class="tag tw">TW '+esc(o.tw.toLowerCase())+'</span>';
      if(o.activityCount)tags+='<span class="tag mtg" title="Meeting history, last on '+esc(new Date(o.lastActivityAt).toLocaleDateString("en-US",{month:"short",day:"numeric"}))+'">'+o.activityCount+(o.activityCount===1?" meeting":" meetings")+'</span>';
      var cd=parseDate(o.closeDate),late=cd&&isOpen(o)&&cd<today;
      var age=daysAgo(o.updatedAt),stale=age!=null&&age>14&&isOpen(o);
      var who=(o.updatedBy||"").split("@")[0];
      var updTxt=age==null?"":(age<=0?"Today":age===1?"Yesterday":age+"d ago")+(who?" · "+esc(who.split(" ")[0]):"");
      var gmNote=o.gmPct!=null?' <span class="tag tw" title="GM% override">'+gmOf(o)+'% GM</span>':"";
      return '<tr class="'+(isOpen(o)?"":"closed")+'">'+
        '<td><button class="acct" type="button" data-open="'+esc(o.id)+'">'+esc(o.account)+'</button>'+
          (o.opportunity?'<div class="opp">'+esc(o.opportunity)+'</div>':"")+
          (tags||gmNote?'<div class="tags">'+tags+gmNote+'</div>':"")+'</td>'+
        '<td>'+stagePill(o)+'</td>'+
        '<td class="who"><b>'+(o.seller?esc(o.seller):'<span style="color:var(--ink-3);font-weight:400">Unassigned</span>')+'</b><span>'+esc([o.lead?o.lead+" lead":"",o.segment||""].filter(Boolean).join(" · "))+'</span></td>'+
        '<td class="num">'+(o.size==null?'<span class="na">–</span>':full(o.size))+'</td>'+
        '<td class="num">'+(m==null?'<span class="na">–</span>':full(m))+'</td>'+
        '<td class="num">'+(w==null?'<span class="na">–</span>':full(w))+'</td>'+
        '<td class="next"><div title="'+esc(o.nextStep||"")+'">'+esc(o.nextStep||"")+'</div></td>'+
        '<td class="date'+(late?" late":"")+'">'+(cd?fmtDate(cd)+(late?" (overdue)":""):'<span class="na">–</span>')+'</td>'+
        '<td class="upd'+(stale?" stale":"")+'">'+updTxt+'</td></tr>';
    }).join("");
  }
  var ts=0,tm=0,tw=0,n=0;
  rows.forEach(function(o){var m=marginOf(o);if(o.size!=null&&isOpen(o)){ts+=o.size}if(m!=null&&isOpen(o)){tm+=m;tw+=weightedOf(o)}if(isOpen(o))n++});
  $("tfoot").innerHTML=rows.length?'<tr><td class="lbl" colspan="3">Total, open opportunities shown ('+n+')</td><td class="num">'+full(ts)+'</td><td class="num">'+full(tm)+'</td><td class="num">'+full(tw)+'</td><td colspan="3"></td></tr>':"";
  $("count").textContent="Showing "+rows.length+" of "+S.opps.length;
  var sel=$("sellers"),set={};S.opps.forEach(function(o){if(o.seller)set[o.seller]=1});
  for(var sn in S.sellers){if(Object.prototype.hasOwnProperty.call(S.sellers,sn))set[sn]=1}
  sel.innerHTML=Object.keys(set).sort().map(function(s){return '<option value="'+esc(s)+'">'}).join("");
}
function syncAssumptions(){
  var a=document.activeElement,st=S.settings;
  function put(id,v){var el=$(id);if(el!==a)el.value=v}
  $("basisPrice").checked=st.marginBasis!=="cost";$("basisCost").checked=st.marginBasis==="cost";
  put("defGm",st.defaultGm);
  STAGES.forEach(function(s){put("p-"+STAGES.indexOf(s),st.probs[s]==null?0:st.probs[s])});
  $("assumpSum").textContent=(st.marginBasis==="cost"?"Cost basis":"Sell price basis")+", "+st.defaultGm+"% default GM";
}
function renderDash(){
  if(S.tab!=="dash"||!window.Dash)return;
  window.Dash.render({opps:S.opps,settings:S.settings,loaded:S.loaded,hooks:{showGaps:showGapRows}});
}
function render(skipAssump){
  renderHead();renderBand();renderInsights();renderTable();
  if(!skipAssump)syncAssumptions();
  updateSync();
  renderDash();
}

/* ---------- tabs ---------- */
function setTab(t,focus){
  S.tab=t==="dash"?"dash":"pipeline";
  var dash=S.tab==="dash";
  $("view-pipeline").hidden=dash;$("view-dash").hidden=!dash;
  [["tabPipeline",!dash],["tabDash",dash]].forEach(function(x){
    var b=$(x[0]);b.setAttribute("aria-selected",String(x[1]));b.tabIndex=x[1]?0:-1;
    if(focus&&x[1])b.focus();
  });
  try{history.replaceState(null,"",dash?"#dashboard":location.pathname+location.search)}catch(e){}
  if(dash)renderDash();
}
function showGapRows(){
  S.f.gaps=true;S.f.stage="open";
  $("fGaps").checked=true;$("fStage").value="open";
  setTab("pipeline");renderTable();
  window.scrollTo(0,0);
}
function updateSync(){
  var el=$("sync"),t=$("syncTxt");
  if(S.offline){el.dataset.state="off";t.textContent=S.loaded?"Offline, retrying":"Can't connect"}
  else if(!S.loaded){el.dataset.state="wait";t.textContent="Connecting"}
  else{el.dataset.state="live";t.textContent=S.me?"Connected as "+S.me.split("@")[0]:"Connected"}
  $("addBtn").hidden=!S.canWrite;
  ["importBtn","exportBtn"].forEach(function(id){
    var b=$(id);b.classList.toggle("off",!S.bulk);
    b.title=S.bulk?"":"Turned off until sign in is enabled. See the README, Before real customer data.";
  });
}

/* ---------- drawer ---------- */
function fillSelect(el,opts,blank){
  el.innerHTML=(blank!=null?'<option value="">'+esc(blank)+'</option>':"")+opts.map(function(o){return '<option>'+esc(o)+'</option>'}).join("");
}
function readForm(){
  var size=parseMoney($("f-size").value),gm=$("f-gm").value.trim();
  return {
    account:$("f-account").value.trim(),opportunity:$("f-opp").value.trim(),stage:$("f-stage").value,
    segment:$("f-segment").value,lead:$("f-lead").value,seller:$("f-seller").value.trim(),tw:$("f-tw").value,
    closeDate:$("f-close").value,size:size,gmPct:gm===""?null:Number(gm),
    nextStep:$("f-next").value.trim(),notes:$("f-notes").value.trim()
  };
}
function updatePreview(){
  var d=readForm(),bad=isNaN(d.size);
  if(bad){$("preview").textContent="Deal size needs to be a number, like 250000 or 250k.";return}
  d.size=d.size==null?null:d.size;
  var m=marginOf(d),w=m==null?null:m*probOf(d);
  $("preview").innerHTML=m==null?"Add a deal size to see margin.":
    'Est. margin <b>'+full(m)+'</b> at '+gmOf(d)+'% GM. Weighted <b>'+full(w)+'</b> at '+Math.round(probOf(d)*100)+'% for '+esc(d.stage)+'.';
}
function setDelLabel(){$("ddel").textContent=S.delArmed?"Confirm delete":"Delete"}
function openDrawer(id){
  var o=id?S.opps.filter(function(x){return x.id===id})[0]:null;
  S.editing=id||null;S.delArmed=false;setDelLabel();
  $("dtitle").textContent=o?"Edit opportunity":"New opportunity";
  var v=o||{stage:"Identified",lead:"",segment:"",tw:"Not indicated"};
  $("f-account").value=v.account||"";$("f-opp").value=v.opportunity||"";
  $("f-stage").value=v.stage||"Identified";$("f-segment").value=v.segment||"";$("f-lead").value=v.lead||"";
  $("f-seller").value=v.seller||"";$("f-tw").value=v.tw||"Not indicated";$("f-close").value=v.closeDate||"";
  $("f-size").value=v.size==null?"":v.size;$("f-gm").value=v.gmPct==null?"":v.gmPct;
  $("f-next").value=v.nextStep||"";$("f-notes").value=v.notes||"";
  var who=o&&(o.updatedBy||"").split("@")[0];
  $("dmeta").textContent=o&&o.updatedAt?"Last saved "+new Date(o.updatedAt).toLocaleDateString("en-US",{month:"short",day:"numeric"})+(who?" by "+who:""):"";
  $("ddel").hidden=!o||!S.canWrite;$("dsave").hidden=!S.canWrite;$("dreq").hidden=!o||!S.canWrite;
  ["f-account","f-opp","f-stage","f-segment","f-lead","f-seller","f-tw","f-close","f-size","f-gm","f-next","f-notes"].forEach(function(i){$(i).disabled=!S.canWrite});
  updatePreview();loadHistory(o);
  $("scrim").hidden=false;$("drawer").hidden=false;
  setTimeout(function(){$("f-account").focus()},30);
}
function closeDrawer(){$("drawer").hidden=true;$("scrim").hidden=true;S.editing=null}
function shortDate(iso){var d=new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso)?iso+"T00:00:00":iso);return isNaN(d)?"":d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:d.getFullYear()===new Date().getFullYear()?undefined:"numeric"})}
function bullets(title,list){return list&&list.length?'<p class="h-t">'+title+'</p><ul>'+list.map(function(x){return '<li>'+esc(x)+'</li>'}).join("")+'</ul>':""}
function loadHistory(o){
  var box=$("dhist");
  if(!o||!o.activityCount){box.hidden=true;box.innerHTML="";return}
  var id=o.id;
  box.hidden=false;box.innerHTML='<h3>Meeting history</h3><p class="hint">Loading</p>';
  api("GET","/api/opps/"+encodeURIComponent(id)+"/activity").then(function(r){
    if(S.editing!==id)return;
    box.innerHTML='<h3>Meeting history <small>'+r.items.length+'</small></h3>'+r.items.map(function(a,i){
      var who=(a.by||"").split("@")[0];
      return '<details class="hist-item"'+(i===0?" open":"")+'><summary><b>'+esc(shortDate(a.date))+'</b> <span>'+esc(a.source||"")+(who?" · "+esc(who):"")+'</span></summary>'+
        (a.summary?'<p>'+esc(a.summary)+'</p>':"")+bullets("Decisions",a.decisions)+bullets("Action items",a.actionItems)+bullets("Risks",a.risks)+
        (a.applied&&a.applied.length?'<p class="hint">Updated: '+esc(a.applied.join(", "))+'</p>':"")+'</details>';
    }).join("");
  },function(e){if(S.editing===id)box.innerHTML='<h3>Meeting history</h3><p class="hint">Could not load it: '+esc(errMsg(e))+'</p>'});
}
/* ---------- request update from the seller ---------- */
/* Nothing here sends mail. A mailto: link opens the person's own mail client with the seller's address,
   a subject and a body already filled in; they review it and send it themselves, from their own mailbox.
   The only thing the server stores is the seller's email address, once, in the seller directory. */
function updateMailBody(d){
  var lines=["Hi "+(d.seller||"")+",","","Could you send a quick status update on this one when you get a chance?",""];
  lines.push("Account: "+(d.account||""));
  if(d.opportunity)lines.push("Opportunity: "+d.opportunity);
  lines.push("Stage: "+d.stage);
  if(d.closeDate)lines.push("Expected close: "+shortDate(d.closeDate));
  if(d.nextStep)lines.push("Next step on file: "+d.nextStep);
  lines.push("","Thanks!");
  return lines.join("\n");
}
function openUpdateMail(d,email){
  var subject="Status update: "+(d.account||"opportunity")+(d.opportunity?" ("+d.opportunity+")":"");
  var href="mailto:"+encodeURIComponent(email)+"?subject="+encodeURIComponent(subject)+"&body="+encodeURIComponent(updateMailBody(d));
  // A clicked mailto: link hands off to the OS mail handler without touching this page (unlike
  // location.href=, which some browsers treat as a real, if aborted, navigation attempt).
  var a=document.createElement("a");a.href=href;a.rel="noopener";
  document.body.appendChild(a);a.click();document.body.removeChild(a);
}
var pendingReq=null;
function openSellerPrompt(d){
  pendingReq=d;
  $("sHint").textContent="No email saved for "+d.seller+" yet. Save it once and every deal of theirs will have it.";
  $("sEmail").value="";$("sErr").hidden=true;$("sSave").disabled=false;
  $("sscrim").hidden=false;$("smodal").hidden=false;
  setTimeout(function(){$("sEmail").focus()},30);
}
function closeSellerPrompt(){$("sscrim").hidden=true;$("smodal").hidden=true;pendingReq=null}
function saveSellerEmail(){
  var d=pendingReq;if(!d)return;
  var email=$("sEmail").value.trim();
  $("sSave").disabled=true;$("sErr").hidden=true;
  api("POST","/api/sellers",{name:d.seller,email:email}).then(function(r){
    S.sellers[r.seller.name]=r.seller.email;
    closeSellerPrompt();
    openUpdateMail(d,r.seller.email);
  },function(e){
    $("sSave").disabled=false;
    $("sErr").textContent=errMsg(e);$("sErr").hidden=false;
    setTimeout(function(){$("sEmail").focus()},10);
  });
}
function doRequestUpdate(){
  var d=readForm();
  if(!d.seller){toast("Set a seller on this opportunity first",true);return}
  var email=sellerEmail(d.seller);
  if(email)openUpdateMail(d,email);else openSellerPrompt(d);
}

function doSave(){
  var d=readForm();
  if(!d.account){toast("Account name is required.",true);$("f-account").focus();return}
  if(isNaN(d.size)){toast("Deal size needs to be a number.",true);$("f-size").focus();return}
  if(d.gmPct!=null&&(isNaN(d.gmPct)||d.gmPct<1||d.gmPct>90)){toast("GM% must be between 1 and 90.",true);return}
  $("dsave").disabled=true;
  var p=S.editing?saveOpp(S.editing,d):addOpp(d);
  p.then(function(ok){$("dsave").disabled=false;if(ok){closeDrawer();toast("Saved")}});
}
function doDelete(){
  if(!S.delArmed){S.delArmed=true;setDelLabel();return}
  delOpp(S.editing).then(function(ok){if(ok){closeDrawer();toast("Deleted")}});
}

/* ---------- export ---------- */
var BULK_OFF="Import and export are turned off until sign in is enabled. See the README, Before real customer data.";
function doExport(){
  if(!S.bulk){toast(BULK_OFF,true);return}
  var b=$("exportBtn");b.disabled=true;
  fetch("/api/export",{credentials:"same-origin"}).then(function(r){
    if(!r.ok){
      return r.text().then(function(t){
        var d=null;try{d=JSON.parse(t)}catch(e){}
        throw new Error((d&&d.error)||("Export failed ("+r.status+")"));
      });
    }
    var m=/filename="([^"]+)"/.exec(r.headers.get("Content-Disposition")||"");
    return r.blob().then(function(blob){return {blob:blob,name:m?m[1]:"ai-pipeline.xlsx"}});
  }).then(function(x){
    var url=URL.createObjectURL(x.blob),a=document.createElement("a");
    a.href=url;a.download=x.name;document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(url)},1500);
    toast("Exported "+S.opps.length+" opportunities to "+x.name);
  }).catch(function(e){toast(e.message||"Export failed.",true)}).then(function(){b.disabled=false});
}

/* ---------- import ---------- */
var imp={b64:"",token:0};
var MAX_UPLOAD=4*1024*1024;
function n(x){return Number(x).toLocaleString("en-US")}
function openImport(){
  if(!S.bulk){toast(BULK_OFF,true);return}
  imp.b64="";imp.token++;
  $("imFile").value="";$("imResult").innerHTML="";$("imMeta").textContent="";
  $("imGo").disabled=true;$("imGo").textContent="Import";
  $("iscrim").hidden=false;$("imodal").hidden=false;
  setTimeout(function(){$("imFile").focus()},30);
}
function closeImport(){imp.token++;$("imodal").hidden=true;$("iscrim").hidden=true}
function readB64(file){
  return new Promise(function(res,rej){
    var r=new FileReader();
    r.onload=function(){var s=String(r.result);res(s.slice(s.indexOf(",")+1))};
    r.onerror=function(){rej(new Error("Could not read that file."))};
    r.readAsDataURL(file);
  });
}
function importError(msg){
  $("imResult").innerHTML='<div class="im-err">'+esc(msg)+'</div>';
  $("imGo").disabled=true;
}
function onPickFile(){
  var f=$("imFile").files[0],my=++imp.token;
  imp.b64="";$("imGo").disabled=true;$("imMeta").textContent="";
  if(!f){$("imResult").innerHTML="";return}
  if(f.size>MAX_UPLOAD){importError("That file is "+(f.size/1048576).toFixed(1)+" MB. The limit is 4 MB.");return}
  $("imResult").innerHTML='<p class="im-kind">Reading '+esc(f.name)+'</p>';
  readB64(f).then(function(b64){
    imp.b64=b64;
    return api("POST","/api/import/preview",{data:b64});
  }).then(function(p){
    if(my!==imp.token)return;
    renderPreview(p,f.name);
  },function(e){
    if(my!==imp.token)return;
    imp.b64="";importError(errMsg(e));
  });
}
function renderPreview(p,name){
  var s=p.summary,kind=p.format==="legacy"
    ?'Original workbook layout, sheet <b>'+esc(p.sheet)+'</b>. Only new accounts are added. Anything already in the tracker is left as it is.'
    :'Export layout, sheet <b>'+esc(p.sheet)+'</b>. Rows are matched by Id and updated. Blank cells clear that field.';
  var skipped=p.rows.filter(function(r){return r.action==="skip"});
  var changes=p.rows.filter(function(r){return r.action==="create"||r.action==="update"});
  var warned=p.rows.filter(function(r){return r.action!=="skip"&&r.warnings&&r.warnings.length});
  var html='<p class="im-kind">'+esc(name)+': '+kind+'</p>'+
    '<div class="im-metrics">'+
      '<div><b>'+n(s.create)+'</b><span>New</span></div>'+
      '<div><b>'+n(s.update)+'</b><span>Updated</span></div>'+
      '<div><b>'+n(s.unchanged)+'</b><span>Unchanged</span></div>'+
      '<div'+(s.skipped?' class="warn"':'')+'><b>'+n(s.skipped)+'</b><span>Skipped</span></div>'+
    '</div>';
  if(skipped.length){
    html+='<details class="im-box bad" open><summary>'+n(skipped.length)+(skipped.length===1?' row will be skipped':' rows will be skipped')+'</summary><ul>'+
      skipped.map(function(r){return '<li>Row '+r.line+(r.account?' ('+esc(r.account)+')':'')+': '+esc(r.reason)+'</li>'}).join("")+'</ul></details>';
  }
  if(warned.length){
    html+='<details class="im-box bad" open><summary>Check these</summary><ul>'+
      warned.map(function(r){return '<li>Row '+r.line+' ('+esc(r.account)+'): '+esc(r.warnings.join(" "))+'</li>'}).join("")+'</ul></details>';
  }
  if(changes.length){
    html+='<details class="im-box"><summary>What will change</summary><ul>'+
      changes.map(function(r){
        var what=r.action==="create"?"new":"updates "+r.changed.join(", ");
        return '<li>Row '+r.line+' '+esc(r.account)+': '+esc(what)+'</li>';
      }).join("")+(p.truncated?'<li>The list is capped. The import still covers every row.</li>':'')+'</ul></details>';
  }
  if(!s.create&&!s.update&&!s.skipped)html+='<p class="im-kind">Nothing to import. Every row is already in the tracker as it is.</p>';
  $("imResult").innerHTML=html;
  var total=s.create+s.update;
  $("imGo").disabled=!total;
  $("imGo").textContent=total?"Import "+n(total)+(total===1?" row":" rows"):"Nothing to import";
  $("imMeta").textContent=s.blankRows?n(s.blankRows)+" blank rows ignored":"";
}
function doImport(){
  if(!imp.b64){closeImport();return}
  var my=++imp.token;
  $("imGo").disabled=true;$("imGo").textContent="Importing";
  api("POST","/api/import/apply",{data:imp.b64}).then(function(r){
    if(my!==imp.token)return;
    var x=r.result;
    return load().then(function(){
      if(x.failed.length){
        $("imResult").innerHTML='<div class="im-err">'+n(x.created)+' added, '+n(x.updated)+' updated, '+n(x.failed.length)+' could not be saved.</div>'+
          '<details class="im-box bad" open><summary>Not saved</summary><ul>'+
          x.failed.map(function(f){return '<li>Row '+f.line+(f.account?' ('+esc(f.account)+')':'')+': '+esc(f.error)+'</li>'}).join("")+'</ul></details>';
        imp.b64="";$("imGo").disabled=false;$("imGo").textContent="Close";return;
      }
      closeImport();
      toast("Imported: "+n(x.created)+" added, "+n(x.updated)+" updated");
    });
  },function(e){
    if(my!==imp.token)return;
    importError(errMsg(e));$("imGo").textContent="Import";
  });
}

/* ---------- wiring ---------- */
function bind(){
  fillSelect($("f-stage"),STAGES);fillSelect($("f-segment"),SEGMENTS,"Not set");
  fillSelect($("f-lead"),LEADS,"Not set");fillSelect($("f-tw"),TW);
  $("fStage").innerHTML='<option value="all">All stages</option><option value="open">Open only</option>'+STAGES.map(function(s){return '<option>'+esc(s)+'</option>'}).join("");
  $("fLead").innerHTML='<option value="">Any lead</option>'+LEADS.map(function(s){return '<option>'+s+'</option>'}).join("")+'<option value="_none">No lead set</option>';
  $("fSeg").innerHTML='<option value="">Any segment</option>'+SEGMENTS.map(function(s){return '<option>'+esc(s)+'</option>'}).join("");
  $("probs").innerHTML=STAGES.map(function(s,i){return '<label>'+esc(s)+' %<input type="number" min="0" max="100" step="5" id="p-'+i+'"></label>'}).join("");

  $("q").addEventListener("input",function(e){S.f.q=e.target.value;renderTable()});
  $("fStage").addEventListener("change",function(e){S.f.stage=e.target.value;renderTable()});
  $("fLead").addEventListener("change",function(e){S.f.lead=e.target.value;renderTable()});
  $("fSeg").addEventListener("change",function(e){S.f.seg=e.target.value;renderTable()});
  $("fGaps").addEventListener("change",function(e){S.f.gaps=e.target.checked;renderTable()});

  $("thead").addEventListener("click",function(e){
    var b=e.target.closest("[data-sort]");if(!b)return;
    var k=b.getAttribute("data-sort");
    if(S.sort.k===k)S.sort.d=S.sort.d==="asc"?"desc":"asc";
    else{S.sort.k=k;S.sort.d=(k==="account"||k==="seller"||k==="next"||k==="stage"||k==="close")?"asc":"desc"}
    renderHead();renderTable();
  });
  $("tbody").addEventListener("click",function(e){
    var b=e.target.closest("[data-open]");if(b)openDrawer(b.getAttribute("data-open"));
  });
  $("tbody").addEventListener("change",function(e){
    var s=e.target.closest(".stage-sel");if(!s)return;
    s.parentNode.setAttribute("data-stage",s.value);
    saveOpp(s.getAttribute("data-id"),{stage:s.value}).then(function(ok){if(ok)toast("Stage updated")});
  });
  $("tabPipeline").addEventListener("click",function(){setTab("pipeline")});
  $("tabDash").addEventListener("click",function(){setTab("dash")});
  $("view-pipeline").parentNode.querySelector(".tabs").addEventListener("keydown",function(e){
    if(e.key==="ArrowRight"||e.key==="ArrowLeft"){setTab(S.tab==="dash"?"pipeline":"dash",true);e.preventDefault()}
  });
  window.addEventListener("hashchange",function(){setTab(location.hash==="#dashboard"?"dash":"pipeline")});
  var ts=$("themeSel");
  if(window.PipelineTheme){
    ts.value=window.PipelineTheme.get();
    ts.addEventListener("change",function(){window.PipelineTheme.set(ts.value);if(window.Dash)window.Dash.rerender()});
  }else ts.hidden=true;
  $("addBtn").addEventListener("click",function(){openDrawer(null)});
  $("exportBtn").addEventListener("click",doExport);
  $("importBtn").addEventListener("click",openImport);
  $("imClose").addEventListener("click",closeImport);$("imCancel").addEventListener("click",closeImport);
  $("iscrim").addEventListener("click",closeImport);
  $("imFile").addEventListener("change",onPickFile);
  $("imGo").addEventListener("click",doImport);
  $("dclose").addEventListener("click",closeDrawer);$("dcancel").addEventListener("click",closeDrawer);
  $("scrim").addEventListener("click",closeDrawer);
  $("dsave").addEventListener("click",doSave);$("ddel").addEventListener("click",doDelete);
  $("dreq").addEventListener("click",doRequestUpdate);
  $("sclose").addEventListener("click",closeSellerPrompt);$("sCancel").addEventListener("click",closeSellerPrompt);
  $("sscrim").addEventListener("click",closeSellerPrompt);$("sSave").addEventListener("click",saveSellerEmail);
  $("sEmail").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();saveSellerEmail()}});
  $("dform").addEventListener("input",updatePreview);
  $("dform").addEventListener("submit",function(e){e.preventDefault();doSave()});
  document.addEventListener("keydown",function(e){
    if(e.key!=="Escape")return;
    if(!$("smodal").hidden)closeSellerPrompt();else if(!$("imodal").hidden)closeImport();else if(!$("drawer").hidden)closeDrawer();
  });
  ["basisPrice","basisCost","defGm"].forEach(function(i){$(i).addEventListener("input",saveSettings);$(i).addEventListener("change",saveSettings)});
  $("probs").addEventListener("input",saveSettings);
}

function mergeSettings(d){
  var s=clone(DEFAULTS);
  if(d){
    if(d.marginBasis==="cost"||d.marginBasis==="price")s.marginBasis=d.marginBasis;
    if(typeof d.defaultGm==="number")s.defaultGm=d.defaultGm;
    if(d.probs)STAGES.forEach(function(st){if(typeof d.probs[st]==="number")s.probs[st]=d.probs[st]});
  }
  return s;
}
function showBanner(msg,detail){
  var b=$("banner");
  b.innerHTML=esc(msg)+(detail?"<small>"+esc(detail)+"</small>":"");
  b.hidden=false;
}
function load(){
  return Promise.all([api("GET","/api/opps"),api("GET","/api/settings"),api("GET","/api/sellers")]).then(function(r){
    S.opps=r[0].items||[];
    if(!settingsDirty)S.settings=mergeSettings(r[1].settings);
    S.sellers=r[2].sellers||{};
    S.loaded=true;S.offline=false;S.err="";
    $("banner").hidden=true;
    render();
  }).catch(function(e){
    S.offline=true;S.err=errMsg(e);
    showBanner(S.loaded?"Connection lost. Showing the last data received. Retrying every 20 seconds.":"Can't reach the pipeline service.",S.err);
    render(true);
  });
}
function busy(){return !$("drawer").hidden||!$("imodal").hidden||!$("tmodal").hidden||!$("smodal").hidden||settingsDirty||!!document.querySelector(".stage-sel:focus")}
function init(){
  bind();
  if(location.hash==="#dashboard")setTab("dash");
  render();
  window.addEventListener("error",function(e){showBanner("Something went wrong in the page.",e.message)});
  window.addEventListener("unhandledrejection",function(e){showBanner("Something went wrong in the page.",e.reason&&e.reason.message)});
  api("GET","/api/me").then(function(m){S.me=m.name||"";S.bulk=!!m.bulk;S.ai=!!m.ai;S.aiWhy=m.aiWhy||"";S.aiDemo=!!m.aiDemo;updateSync()},function(){});
  load();
  setInterval(function(){if(!document.hidden&&!busy())load()},20000);
  document.addEventListener("visibilitychange",function(){if(!document.hidden&&!busy())load()});
}
/* what the transcript dialog (transcript.js) needs from this file */
window.PipelineApp={api:api,toast:toast,esc:esc,errMsg:errMsg,load:load,parseMoney:parseMoney,full:full,openDrawer:openDrawer,shortDate:shortDate,
  opps:function(){return S.opps},ai:function(){return {ok:S.ai,why:S.aiWhy,demo:S.aiDemo}},canWrite:function(){return S.canWrite}};
init();
})();
