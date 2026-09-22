/* "From transcript": paste or drop meeting notes, review what the AI proposes, then save.
   Three steps in one dialog: input, review, done. Nothing is saved until Save on the review step, and every
   proposed change is a checkbox with the transcript quote that supports it. */
(function(){
"use strict";
var A=window.PipelineApp;
if(!A)return;
var $=function(id){return document.getElementById(id)};
var esc=A.esc;
var STAGES=["Identified","Discovery","Qualified","Proposal / RFP","Blocked","Won","Lost"];
var TW=["Engaged","Strong fit","Target","Potential","Not indicated","Zones only"];
var LEADS=["Zones","Thoughtworks"];
var SEGMENTS=["ITS","ENT","MM","Healthcare","SLED / Public Sector Utility"];
var MAX_FILE=4*1024*1024;
var EXT=/\.(txt|md|vtt|srt|docx)$/i;
var tx=fresh();
var tick=null;

function today(){var d=new Date();return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2)}
function fresh(){return {step:"input",mode:"update",oppId:"",date:today(),text:"",file:null,token:0,proposal:null,result:null,err:""}}
function n(x){return Number(x).toLocaleString("en-US")}

/* ---------- open and close ---------- */
var OFF={
  signin:"Transcript analysis is turned off until sign in is enabled. See the README, Before real customer data.",
  "not-configured":"Transcript analysis is not set up yet. It needs a Microsoft Foundry resource. See the README, Transcripts."
};
function open(file){
  var s=A.ai();
  if(!s.ok){A.toast(OFF[s.why]||OFF["not-configured"],true);return}
  if(!A.canWrite()){A.toast("This page is read only.",true);return}
  var keepToken=tx.token;tx=fresh();tx.token=keepToken+1;
  $("tscrim").hidden=false;$("tmodal").hidden=false;
  render();
  if(file)acceptFile(file);
}
function close(){tx.token++;stopTick();$("tmodal").hidden=true;$("tscrim").hidden=true}
function stopTick(){if(tick){clearInterval(tick);tick=null}}

/* ---------- files ---------- */
function readB64(file){
  return new Promise(function(res,rej){
    var r=new FileReader();
    r.onload=function(){var s=String(r.result);res(s.slice(s.indexOf(",")+1))};
    r.onerror=function(){rej(new Error("Could not read that file."))};
    r.readAsDataURL(file);
  });
}
function acceptFile(file){
  if(tx.step!=="input")return;
  if(!EXT.test(file.name)){A.toast("Use a .txt, .vtt, .srt or .docx file, or paste the text.",true);return}
  if(file.size>MAX_FILE){A.toast("That file is "+(file.size/1048576).toFixed(1)+" MB. The limit is 4 MB.",true);return}
  readB64(file).then(function(b64){tx.file={name:file.name,b64:b64,size:file.size};tx.err="";render()},
    function(e){A.toast(e.message,true)});
}

/* ---------- rendering ---------- */
function setFooter(o){
  $("tmGo").hidden=!!o.hideGo;$("tmGo").textContent=o.go||"";$("tmGo").disabled=!!o.goOff;
  $("tmBack").hidden=!o.back;$("tmCancel").textContent=o.cancel||"Cancel";$("tmMeta").textContent=o.meta||"";
}
function render(){
  stopTick();
  if(tx.step==="input")renderInput();
  else if(tx.step==="working")renderWorking();
  else if(tx.step==="review")renderReview();
  else renderDone();
}
function ready(){return !!tx.file||tx.text.trim().length>=40}
function renderInput(){
  var opps=A.opps().slice().sort(function(a,b){return a.account.localeCompare(b.account)});
  var sel='<option value="">Detect it from the transcript</option>'+opps.map(function(o){
    return '<option value="'+esc(o.id)+'"'+(o.id===tx.oppId?" selected":"")+'>'+esc(o.account)+(o.opportunity?" · "+esc(o.opportunity.slice(0,48)):"")+'</option>';
  }).join("");
  var demo=A.ai().demo?'<div class="tm-demo">Demo mode: a simple keyword matcher stands in for the AI model, so expect rough results. Nothing leaves this computer.</div>':"";
  $("tmTitle").textContent="Add from transcript";
  $("tmBody").innerHTML=demo+
    '<p class="tm-lead">Paste meeting notes or a Teams transcript, or drop a file. The AI proposes changes and a summary. You review every change before anything is saved. The transcript itself is not stored by this app, only the summary you approve.</p>'+
    (tx.err?'<div class="im-err" role="alert">'+esc(tx.err)+'</div>':"")+
    '<fieldset class="tm-modes"><legend>What is this meeting about?</legend>'+
      '<label class="tm-mode"><input type="radio" name="tmMode" value="update"'+(tx.mode==="update"?" checked":"")+'><span><b>An existing opportunity</b><small>Update fields like stage, size, close date and next step, and add a meeting entry to its history.</small></span></label>'+
      '<label class="tm-mode"><input type="radio" name="tmMode" value="new"'+(tx.mode==="new"?" checked":"")+'><span><b>A new opportunity</b><small>Create a row from what was said. You confirm the account and every value first.</small></span></label>'+
    '</fieldset>'+
    '<div class="tm-row">'+
      (tx.mode==="update"?'<label>Opportunity<select id="tmOpp">'+sel+'</select></label>':'<div></div>')+
      '<label>Meeting date<input type="date" id="tmDate" value="'+esc(tx.date)+'" max="'+esc(today())+'"></label>'+
    '</div>'+
    '<div class="tm-drop" id="tmDrop">'+
      (tx.file?'<div class="tm-file"><span>File</span> <b>'+esc(tx.file.name)+'</b> <span>'+(tx.file.size/1024).toFixed(0)+' KB</span><button class="btn small" id="tmRm" type="button">Remove</button></div>':
        '<label class="tm-field"><span class="sr">Transcript text</span><textarea id="tmText" placeholder="Paste the transcript or your notes here, or drop a .txt, .vtt, .srt or .docx file anywhere in this box." spellcheck="false">'+esc(tx.text)+'</textarea></label>')+
      '<div class="tm-drop-h"><span id="tmCount">'+(tx.file?"":n(tx.text.length)+" characters")+'</span><label class="btn small" style="cursor:pointer">Choose a file<input type="file" id="tmFile" accept=".txt,.md,.vtt,.srt,.docx" class="sr"></label></div>'+
    '</div>';
  setFooter({go:"Analyze transcript",goOff:!ready(),cancel:"Cancel",meta:"Up to 200,000 characters or a 4 MB file"});
  setTimeout(function(){var t=$("tmText")||$("tmFile");if(t)t.focus()},30);
}
function renderWorking(){
  $("tmTitle").textContent="Reading the transcript";
  var t0=Date.now();
  $("tmBody").innerHTML='<div class="tm-work" role="status" aria-live="polite"><div class="tm-spin" aria-hidden="true"></div>'+
    '<div>Analyzing the transcript. This usually takes 10 to 40 seconds.</div><div id="tmElapsed" class="hint">0 s</div></div>';
  setFooter({hideGo:true,cancel:"Cancel"});
  tick=setInterval(function(){var e=$("tmElapsed");if(e)e.textContent=Math.round((Date.now()-t0)/1000)+" s"},1000);
}

function shown(field,v,isNew){
  if(isNew)return "New";
  if(v==null||v==="")return "Not set";
  if(field==="size")return A.full(v);
  if(field==="gmPct")return v+"%";
  if(field==="closeDate")return A.shortDate(v);
  return String(v);
}
function fieldInput(c,i){
  var id="tmv"+i,v=c.to,opts=null;
  if(c.field==="stage")opts=STAGES;else if(c.field==="tw")opts=TW;else if(c.field==="lead")opts=LEADS;else if(c.field==="segment")opts=SEGMENTS;
  var lbl='<label class="sr" for="'+id+'">Proposed '+esc(c.label.toLowerCase())+'</label>';
  if(opts)return lbl+'<select id="'+id+'" data-f="'+c.field+'">'+opts.map(function(o){return '<option'+(o===v?" selected":"")+'>'+esc(o)+'</option>'}).join("")+'</select>';
  if(c.field==="closeDate")return lbl+'<input type="date" id="'+id+'" data-f="closeDate" value="'+esc(v)+'">';
  if(c.field==="size")return lbl+'<input type="text" inputmode="decimal" id="'+id+'" data-f="size" value="'+esc(v)+'" placeholder="e.g. 250000 or 250k">';
  if(c.field==="gmPct")return lbl+'<input type="number" min="1" max="90" step="1" id="'+id+'" data-f="gmPct" value="'+esc(v)+'">';
  if(c.field==="opportunity"||c.field==="nextStep")return lbl+'<textarea id="'+id+'" data-f="'+c.field+'">'+esc(v)+'</textarea>';
  return lbl+'<input type="text" id="'+id+'" data-f="'+c.field+'" value="'+esc(v)+'">';
}
function list(title,items){return items&&items.length?'<p class="h-t">'+title+'</p><ul>'+items.map(function(x){return '<li>'+esc(x)+'</li>'}).join("")+'</ul>':""}

function renderReview(){
  var p=tx.proposal,isNew=p.mode==="new",changes=p.changes.slice();
  $("tmTitle").textContent=isNew?"Review the new opportunity":"Review the changes";
  // A new opportunity needs an account. If the model found none, give the person an empty row to fill in.
  if(isNew&&!changes.some(function(c){return c.field==="account"})){
    changes.unshift({field:"account",label:"Account",from:null,to:"",quote:"",quoteFound:true,manual:true});
  }
  p._rows=changes;
  var html="";
  if(A.ai().demo)html+='<div class="tm-demo">Demo mode: this came from a keyword matcher, not an AI model.</div>';
  if(!isNew&&p.target){
    html+='<p class="tm-target">Update <b>'+esc(p.target.account)+'</b>'+(p.match?' <span class="hint">matched from the transcript ('+esc(p.match.confidence)+' confidence). '+esc(p.match.reason)+'</span>':"")+'</p>';
  }
  if(!isNew&&!p.target){
    html+='<div class="tm-notice">The transcript did not clearly name one of your opportunities. '+(p.match&&p.match.reason?esc(p.match.reason)+" ":"")+'Go back and pick the opportunity from the list, or add it as a new one.</div>';
  }
  if(p.duplicates&&p.duplicates.length){
    html+='<div class="tm-dup" role="alert">This looks like a customer you already track. Update that row instead of creating a duplicate?<ul>'+p.duplicates.map(function(d){
      return '<li><b>'+esc(d.account)+'</b> <span>'+esc(d.stage)+(d.opportunity?" · "+esc(d.opportunity):"")+'</span> <button class="btn" type="button" data-dup="'+esc(d.id)+'">Update this one instead</button></li>';
    }).join("")+'</ul></div>';
  }
  (p.notices||[]).forEach(function(m){html+='<div class="tm-notice">'+esc(m)+'</div>'});
  var canSave=isNew||!!p.target;
  if(canSave){
    html+='<p class="tm-h">'+(changes.length?(isNew?"Fields":"Proposed changes"):"No field changes")+'</p>';
    changes.forEach(function(c,i){
      var on=c.manual||c.quoteFound;
      var flag=(c.field==="stage"&&(c.to==="Won"||c.to==="Lost"))?'<span class="tm-flag">Closes the deal</span>':"";
      html+='<div class="tm-chg'+(on?"":" off")+'" data-i="'+i+'">'+
        '<label class="tm-head"><input type="checkbox" class="tm-on"'+(on?" checked":"")+(c.field==="account"&&isNew?" checked disabled":"")+'> <b>'+esc(c.label)+'</b>'+flag+'</label>'+
        '<div class="tm-cur">'+(isNew?"New":"Now: "+esc(shown(c.field,c.from,false)))+'</div>'+
        '<div class="tm-new">'+fieldInput(c,i)+'</div>'+
        (c.quote?'<blockquote class="tm-q'+(c.quoteFound?"":" bad")+'">'+(c.quoteFound?"":"<b>Not found in the transcript, so check this one yourself.</b> ")+"“"+esc(c.quote)+"”</blockquote>":"")+
      '</div>';
    });
    var nt=p.note||{};
    html+='<p class="tm-h">Meeting entry</p><div class="tm-note">'+
      '<label class="tm-head"><input type="checkbox" id="tmNoteOn" checked> Save this summary to the '+(isNew?"new opportunity":"opportunity")+"'s meeting history</label>"+
      '<label class="sr" for="tmSummary">Meeting summary</label><textarea id="tmSummary" maxlength="1500">'+esc(nt.summary||"")+'</textarea>'+
      list("Decisions",nt.decisions)+list("Action items",nt.actionItems)+list("Risks",nt.risks)+
      '<p class="hint" style="margin:0">'+esc(A.shortDate(p.meetingDate))+' · '+esc(p.source||"")+(p.model?" · analyzed by "+esc(p.model):"")+'</p></div>';
  }
  $("tmBody").innerHTML='<div id="tmErr" role="alert"></div>'+html;
  if(tx.err){showErr(tx.err);tx.err=""}
  setFooter({go:isNew?"Create opportunity":"Save changes",hideGo:!canSave,back:true,cancel:"Cancel",meta:""});
  refreshSaveLabel();
}
/** Show a problem without re-rendering, so the person's edits and ticks survive it. */
function showErr(msg){
  var e=$("tmErr");if(!e)return;
  e.innerHTML=msg?'<div class="im-err">'+esc(msg)+'</div>':"";
  if(msg&&e.scrollIntoView)e.scrollIntoView({block:"nearest"});
}
function refreshSaveLabel(){
  var p=tx.proposal;if(!p||tx.step!=="review"||$("tmGo").hidden)return;
  var on=document.querySelectorAll(".tm-chg .tm-on:checked").length,note=$("tmNoteOn")&&$("tmNoteOn").checked;
  if(p.mode==="new"){$("tmGo").textContent="Create opportunity";return}
  $("tmGo").textContent=on?"Save "+on+(on===1?" change":" changes")+(note?" and summary":""):(note?"Save summary only":"Nothing selected");
  $("tmGo").disabled=!on&&!note;
}

function renderDone(){
  var r=tx.result;
  $("tmTitle").textContent="Saved";
  $("tmBody").innerHTML='<div class="tm-done"><b>'+esc(r.headline)+'</b><span>'+esc(r.detail)+'</span></div>';
  setFooter({go:"Open "+(r.mode==="new"?"it":"the opportunity"),cancel:"Close",meta:""});
}

/* ---------- analyze ---------- */
function analyze(){
  var my=++tx.token,body={mode:tx.mode,meetingDate:tx.date};
  if(tx.mode==="update"&&tx.oppId)body.oppId=tx.oppId;
  if(tx.file)body.file={name:tx.file.name,data:tx.file.b64};else body.text=tx.text;
  tx.step="working";tx.err="";render();
  A.api("POST","/api/transcript/analyze",body).then(function(p){
    if(my!==tx.token)return;
    tx.proposal=p;tx.step="review";render();
  },function(e){
    if(my!==tx.token)return;
    tx.step="input";tx.err=A.errMsg(e);render();
  });
}

/* ---------- save ---------- */
function readRow(el,field){
  var v=el.value;
  if(field==="size"){var s=A.parseMoney(v);return s}
  if(field==="gmPct")return v===""?NaN:Number(v);
  return typeof v==="string"?v.trim():v;
}
function save(){
  var p=tx.proposal,isNew=p.mode==="new",fields={},bad="";
  document.querySelectorAll(".tm-chg").forEach(function(row){
    var i=Number(row.getAttribute("data-i")),c=p._rows[i];
    if(!row.querySelector(".tm-on").checked)return;
    var el=row.querySelector("[data-f]"),v=readRow(el,c.field);
    if(c.field==="size"&&(v==null||isNaN(v))){bad="Deal size needs to be a number, like 250000 or 250k.";return}
    if(c.field==="gmPct"&&isNaN(v)){bad="GM% needs to be a number from 1 to 90.";return}
    if(v===""&&c.field!=="account"){return}
    fields[c.field]=v;
  });
  if(!bad&&isNew&&!fields.account)bad="Account name is required.";
  if(bad){showErr(bad);return}
  showErr("");
  var noteOn=$("tmNoteOn")&&$("tmNoteOn").checked,note=null;
  if(noteOn)note={summary:$("tmSummary").value.trim(),decisions:p.note.decisions||[],actionItems:p.note.actionItems||[],risks:p.note.risks||[]};
  var payload={mode:p.mode,meetingDate:p.meetingDate,source:p.source,fields:fields};
  if(note)payload.note=note;
  if(!isNew){payload.oppId=p.target.id;payload.baseUpdatedAt=p.target.updatedAt}
  var my=++tx.token;
  $("tmGo").disabled=true;$("tmGo").textContent="Saving";
  A.api("POST","/api/transcript/apply",payload).then(function(r){
    if(my!==tx.token)return;
    var item=r.item,cnt=Object.keys(fields).length;
    tx.result={mode:p.mode,id:item.id,
      headline:isNew?"Created "+item.account:"Updated "+item.account,
      detail:(isNew?"New opportunity with "+cnt+(cnt===1?" field":" fields"):cnt+(cnt===1?" field":" fields")+" changed")+(note&&(note.summary||note.decisions.length||note.actionItems.length||note.risks.length)?" and a meeting entry added to its history.":".")};
    tx.step="done";
    return A.load().then(render);
  },function(e){
    if(my!==tx.token)return;
    if(e.status===409){tx.step="input";tx.err=A.errMsg(e);render();return}
    showErr(A.errMsg(e));
    $("tmGo").disabled=false;refreshSaveLabel();
  });
}

/* ---------- wiring ---------- */
function bind(){
  $("txBtn").addEventListener("click",function(){open()});
  $("tmClose").addEventListener("click",close);$("tscrim").addEventListener("click",close);
  $("tmCancel").addEventListener("click",close);
  $("tmBack").addEventListener("click",function(){tx.token++;tx.step="input";tx.err="";tx.proposal=null;render()});
  $("tmGo").addEventListener("click",function(){
    if(tx.step==="input"){if(ready())analyze()}
    else if(tx.step==="review")save();
    else if(tx.step==="done"){var id=tx.result.id;close();A.openDrawer(id)}
  });
  var body=$("tmBody");
  body.addEventListener("input",function(e){
    var t=e.target;
    if(t.id==="tmText"){tx.text=t.value;var c=$("tmCount");if(c)c.textContent=n(t.value.length)+" characters";$("tmGo").disabled=!ready()}
    else if(t.id==="tmDate"){tx.date=t.value||today()}
  });
  body.addEventListener("change",function(e){
    var t=e.target;
    if(t.name==="tmMode"){tx.mode=t.value;renderInput();return}
    if(t.id==="tmOpp"){tx.oppId=t.value;return}
    if(t.id==="tmFile"){if(t.files[0])acceptFile(t.files[0]);t.value="";return}
    if(t.classList&&t.classList.contains("tm-on")){t.closest(".tm-chg").classList.toggle("off",!t.checked);refreshSaveLabel();return}
    if(t.id==="tmNoteOn"){refreshSaveLabel();return}
    // editing a proposed value means the person wants it, so tick the box
    var row=t.closest&&t.closest(".tm-chg");
    if(row&&t.hasAttribute("data-f")){var on=row.querySelector(".tm-on");if(!on.checked){on.checked=true;row.classList.remove("off");refreshSaveLabel()}}
  });
  body.addEventListener("click",function(e){
    var t=e.target;
    if(t.id==="tmRm"){tx.file=null;renderInput();return}
    var dup=t.getAttribute&&t.getAttribute("data-dup");
    if(dup){tx.mode="update";tx.oppId=dup;analyze()}
  });
  // drop a file anywhere on the page to start, or onto the dialog to replace the file
  var hasFiles=function(e){return e.dataTransfer&&Array.prototype.indexOf.call(e.dataTransfer.types||[],"Files")>-1};
  window.addEventListener("dragover",function(e){
    if(!hasFiles(e))return;
    e.preventDefault();
    var d=$("tmDrop");if(d&&!$("tmodal").hidden)d.classList.add("over");
  });
  window.addEventListener("dragleave",function(e){var d=$("tmDrop");if(d&&(!e.relatedTarget))d.classList.remove("over")});
  window.addEventListener("drop",function(e){
    if(!hasFiles(e))return;
    e.preventDefault();
    var d=$("tmDrop");if(d)d.classList.remove("over");
    var f=e.dataTransfer.files[0];if(!f)return;
    if($("tmodal").hidden)open(f);else acceptFile(f);
  });
  document.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&!$("tmodal").hidden)close();
  });
}
bind();
})();
