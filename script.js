const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let D=JSON.parse(localStorage.getItem('smartattend')||'null')||{pw:null,st:[],at:[],n:1,m:1};
const save=()=>localStorage.setItem('smartattend',JSON.stringify(D));
const today=()=>new Date().toISOString().slice(0,10);
const sha=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('sa:'+s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const cls=l=>l==='High Performing'?'High':l==='Average'?'Avg':l==='At-Risk'?'Risk':'None';

function predict(T,pct,score,rec){
 if(T<3)return['Not enough data','Needs at least 3 class days of attendance to predict.'];
 if(score>=75&&pct>=75)return['High Performing','Excellent! Try peer mentoring or an advanced project.'];
 if(score<55||pct<65){let t='Meet a mentor this week.';if(pct<75)t+=' Attendance is below 75%, so attend every class.';if(rec<pct)t+=' Recent attendance is dropping.';return['At-Risk',t]}
 return['Average','Steady progress. Better attendance and assignments can lift you to the top band.'];
}
function stats(){
 const days=[...new Set(D.at.map(a=>a.day))].sort().reverse(),T=days.length,l5=days.slice(0,5);
 return{T,rows:D.st.slice().sort((a,b)=>a.roll.localeCompare(b.roll)).map(s=>{
  const mine=D.at.filter(a=>a.sid===s.id),p=mine.length,pct=T?+(p*100/T).toFixed(1):0;
  const rec=l5.length?+(mine.filter(a=>l5.includes(a.day)).length*100/l5.length).toFixed(1):0;
  const score=+(.5*pct+.3*s.marks+.2*s.asg).toFixed(1),[label,tip]=predict(T,pct,score,rec);
  return{...s,present:p,pct,recent:rec,score,label,tip,faces:s.desc.length}})};
}
function mark(sid,method,day){
 day=day||today();if(D.at.some(a=>a.sid===sid&&a.day===day))return false;
 D.at.push({id:D.m++,sid,day,time:new Date().toTimeString().slice(0,8),method});save();return true;
}

const bgc=$('bg'),bx=bgc.getContext('2d');let W,H,P=[],mx=-999,my=-999;
function rs(){W=bgc.width=innerWidth;H=bgc.height=innerHeight}addEventListener('resize',rs);rs();
for(let i=0;i<70;i++)P.push({x:Math.random()*W,y:Math.random()*H,vx:Math.random()*.6-.3,vy:Math.random()*.6-.3});
addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY});
(function loop(){bx.clearRect(0,0,W,H);
 for(const p of P){p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>W)p.vx*=-1;if(p.y<0||p.y>H)p.vy*=-1;
  const dx=p.x-mx,dy=p.y-my,d=Math.hypot(dx,dy)||1;if(d<150){p.x+=dx/d*2.5;p.y+=dy/d*2.5}
  bx.fillStyle='rgba(196,181,253,.85)';bx.beginPath();bx.arc(p.x,p.y,2,0,7);bx.fill()}
 for(let i=0;i<P.length;i++)for(let j=i+1;j<P.length;j++){const d=Math.hypot(P[i].x-P[j].x,P[i].y-P[j].y);
  if(d<110){bx.strokeStyle='rgba(139,92,246,'+(1-d/110)*.5+')';bx.beginPath();bx.moveTo(P[i].x,P[i].y);bx.lineTo(P[j].x,P[j].y);bx.stroke()}}
 requestAnimationFrame(loop)})();
function tick(){const n=new Date(),h=n.getHours();
 $('clock').textContent=n.toLocaleTimeString()+' | '+n.toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'short'});
 $('greet').textContent=(h<12?'Good morning':h<17?'Good afternoon':'Good evening')+', student!'}
setInterval(tick,1000);tick();
function show(v){$('home').classList.toggle('hide',v!=='home');$('admin').classList.toggle('hide',v!=='admin');if(v==='admin'){stopCam();adminInit()}}

const MP='https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';let ready=null;
const models=()=>ready||(ready=Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(MP),faceapi.nets.faceLandmark68Net.loadFromUri(MP),faceapi.nets.faceRecognitionNet.loadFromUri(MP)]));
const det=v=>faceapi.detectSingleFace(v,new faceapi.TinyFaceDetectorOptions({inputSize:320})).withFaceLandmarks().withFaceDescriptor();
let stream=null,timer=null,busy=false;
async function toggleCam(){
 if(stream){stopCam();return}
 try{$('scanmsg').textContent='Loading face models (first time takes a few seconds)...';await models();
  stream=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480}});
  $('cam').srcObject=stream;$('scanbox').classList.add('live');$('camBtn').textContent='Stop Camera';
  $('scanmsg').textContent='Scanning... hold still and look at the camera.';timer=setInterval(scanOnce,1500);
 }catch(e){$('scanmsg').textContent='Camera blocked or models failed to load. Allow camera and check internet.'}
}
function stopCam(){if(timer)clearInterval(timer);timer=null;if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;
 $('scanbox').classList.remove('live');$('camBtn').textContent='Start Camera'}
async function scanOnce(){
 if(busy||!stream)return;busy=true;
 try{
  if(!D.st.some(s=>s.desc.length)){$('scanmsg').textContent='No faces enrolled yet. Ask the admin to enroll students.';busy=false;return}
  const r=await det($('cam'));
  if(!r)$('scanmsg').textContent='No face found. Look at the camera.';
  else{let best=null,bd=9;
   D.st.forEach(s=>s.desc.forEach(d=>{const x=faceapi.euclideanDistance(r.descriptor,d);if(x<bd){bd=x;best=s}}));
   if(!best||bd>.5)$('scanmsg').textContent='Face not recognised. Try better lighting.';
   else{const nw=mark(best.id,'Face');stopCam();$('wname').textContent=best.name;
    $('wsub').textContent=(nw?'Attendance marked for today':'Already marked today')+' | Roll '+best.roll+' | match '+Math.round((1-bd)*100)+'%';
    $('welcome').classList.add('open');burst();setTimeout(()=>$('welcome').classList.remove('open'),3500);
    $('scanmsg').textContent='Done! You can close the camera.'}}
 }catch(e){$('scanmsg').textContent='Could not read camera frame.'}
 busy=false;
}
function burst(){for(let i=0;i<36;i++){const s=document.createElement('div');s.textContent=['✦','★','●','✧'][i%4];
 s.style.cssText='position:fixed;z-index:60;left:50%;top:50%;font-size:'+(14+Math.random()*18)+'px;color:hsl('+(250+Math.random()*60)+',90%,75%);pointer-events:none';
 document.body.appendChild(s);const a=Math.random()*6.28,d=150+Math.random()*320;
 s.animate([{transform:'translate(0,0)',opacity:1},{transform:`translate(${Math.cos(a)*d}px,${Math.sin(a)*d}px) rotate(360deg)`,opacity:0}],{duration:1400,easing:'ease-out'}).onfinish=()=>s.remove()}}

function myStats(){
 const roll=$('rollIn').value.trim().toLowerCase();if(!roll)return;
 const {T,rows}=stats(),r=rows.find(s=>s.roll.toLowerCase()===roll);
 if(!r){$('me').innerHTML='<span style="color:var(--bad)">Roll number not found.</span>';return}
 const C=2*Math.PI*52,col=r.pct>=75?'#34d399':r.pct>=60?'#fbbf24':'#f87171';
 $('me').innerHTML=`<h3 style="margin-bottom:0">${esc(r.name)}</h3><div class="gauge"><svg width="130" height="130"><circle cx="65" cy="65" r="52" stroke="#3b2a5c" stroke-width="12" fill="none"/>
 <circle id="arc" cx="65" cy="65" r="52" stroke="${col}" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" style="transition:1.2s"/></svg>
 <div><b style="color:${col}">${r.pct}%</b><div style="color:var(--m)">${r.present} of ${T} class days</div><span class="tag ${cls(r.label)}">${esc(r.label)}</span></div></div>
 <p style="margin-top:12px">${esc(r.tip)}</p>`;
 setTimeout(()=>$('arc').style.strokeDashoffset=C*(1-Math.min(r.pct,100)/100),50);
}

let tab='dash',enrollId=0,mstream=null;
const TABS={dash:'Dashboard',stu:'Students',rec:'Records',pred:'Prediction',set:'Settings'};
function adminInit(){
 if(D.pw&&sessionStorage.adm){$('loginBox').classList.add('hide');$('panel').classList.remove('hide');go(tab);return}
 $('panel').classList.add('hide');$('loginBox').classList.remove('hide');const first=!D.pw;
 $('loginTitle').textContent=first?'Create Admin Password':'Admin Login';
 $('loginSub').textContent=first?'First time here! Choose a password (6+ characters).':'Only the admin can open this panel.';
 $('pw2row').classList.toggle('hide',!first);$('loginBtn').textContent=first?'Create & enter':'Log in';
}
async function doLogin(){
 const pw=$('pw').value,m=$('loginMsg');m.textContent='';
 if(!D.pw){if(pw.length<6){m.textContent='Password must be at least 6 characters.';return}
  if(pw!==$('pw2').value){m.textContent='Passwords do not match.';return}D.pw=await sha(pw);save()}
 else if(await sha(pw)!==D.pw){m.textContent='Wrong password.';return}
 sessionStorage.adm=1;$('pw').value='';$('pw2').value='';adminInit();
}
function doLogout(){sessionStorage.removeItem('adm');adminInit()}
function go(k){tab=k;$('tabs').innerHTML=Object.entries(TABS).map(([a,b])=>`<button class="tab ${a===k?'on':''}" onclick="go('${a}')">${b}</button>`).join('');({dash:vDash,stu:vStu,rec:vRec,pred:vPred,set:vSet})[k]()}
const stat=(l,n,s='')=>`<div class="stat"><b data-n="${n}" data-s="${s}">0</b><span>${l}</span></div>`;
function countUp(){document.querySelectorAll('[data-n]').forEach(el=>{const end=parseFloat(el.dataset.n),s=el.dataset.s,t0=performance.now();
 (function f(t){const k=Math.min(1,(t-t0)/900),v=end*k;el.textContent=(Number.isInteger(end)?Math.round(v):v.toFixed(1))+s;if(k<1)requestAnimationFrame(f)})(t0)})}
function vDash(){
 const {T,rows}=stats(),td=D.at.filter(a=>a.day===today()).length,risk={};rows.forEach(s=>risk[s.label]=(risk[s.label]||0)+1);
 const avg=rows.length?+(rows.reduce((a,s)=>a+s.pct,0)/rows.length).toFixed(1):0,low=rows.filter(s=>s.pct<75&&T>0);
 const byDay={};D.at.forEach(a=>byDay[a.day]=(byDay[a.day]||0)+1);const daily=Object.keys(byDay).sort().slice(-14).map(d=>({day:d,count:byDay[d]}));
 $('pane').innerHTML=`<div class="stats">${stat('Students',rows.length)}${stat('Present today',td)}${stat('Class days',T)}${stat('Average attendance',avg,'%')}</div>
 <div class="grid2"><div class="card"><h3>Daily attendance (last 14 days)</h3><canvas id="bars" width="520" height="230" style="width:100%"></canvas></div>
 <div class="card"><h3>Performance outlook</h3><div class="donutwrap"><div class="donut" id="donut"></div><div class="legend" id="legend"></div></div></div></div>
 <div class="card"><h3>Students below 75% attendance</h3>${low.length?`<div class="scroll"><table><tr><th>Roll</th><th>Name</th><th>Attendance</th></tr>${low.map(s=>`<tr><td>${esc(s.roll)}</td><td>${esc(s.name)}</td><td><span class="tag Risk">${s.pct}%</span></td></tr>`).join('')}</table></div>`:'<p style="color:var(--m)">Nobody is below 75% yet.</p>'}</div>`;
 countUp();drawBars(daily,Math.max(1,rows.length));drawDonut(risk);
}
function drawBars(d,max){const x=$('bars').getContext('2d'),t0=performance.now();
 (function f(t){const k=Math.min(1,(t-t0)/800);x.clearRect(0,0,520,230);
  if(!d.length){x.fillStyle='#A69BBF';x.font='15px Segoe UI';x.fillText('No attendance yet. Records appear here.',130,115)}
  const bw=Math.min(30,440/Math.max(d.length,1)-8);
  d.forEach((r,i)=>{const h=r.count/max*160*k,px=30+i*(bw+10),py=190-h,g=x.createLinearGradient(0,py,0,190);g.addColorStop(0,'#C4B5FD');g.addColorStop(1,'#7C3AED');
   x.fillStyle=g;x.fillRect(px,py,bw,h);x.fillStyle='#F5F3FF';x.font='12px Segoe UI';x.fillText(r.count,px+bw/4,py-5);x.fillStyle='#A69BBF';x.fillText(r.day.slice(5),px-2,208)});
  if(k<1)requestAnimationFrame(f)})(t0)}
function drawDonut(risk){
 const items=[['High Performing','#34d399'],['Average','#fbbf24'],['At-Risk','#f87171'],['Not enough data','#6b5b95']],tot=items.reduce((s,i)=>s+(risk[i[0]]||0),0);let acc=0,parts=[];
 items.forEach(([n,c])=>{const v=(risk[n]||0)/(tot||1)*100;parts.push(`${c} ${acc}% ${acc+v}%`);acc+=v});
 $('donut').style.background=tot?`conic-gradient(${parts.join(',')})`:'#3b2a5c';
 $('legend').innerHTML=items.map(([n,c])=>`<div><span class="dot" style="background:${c}"></span>${n}: <b>${risk[n]||0}</b></div>`).join('');
}
function vStu(){
 const rows=stats().rows;
 $('pane').innerHTML=`<div class="card"><h3>Add student</h3><div class="grid2" style="gap:10px"><input id="nr" placeholder="Roll number"><input id="nn" placeholder="Full name"><input id="nc" placeholder="Course / class"><input id="nm" type="number" placeholder="Marks % (optional)"><input id="na" type="number" placeholder="Assignments % (optional)"></div>
 <div class="msg" id="smsg" style="margin-top:10px;color:var(--bad)"></div><button class="btn" onclick="addStu()">Add student</button></div>
 <div class="card"><h3>All students (${rows.length})</h3><div class="scroll"><table><tr><th>Roll</th><th>Name</th><th>Course</th><th>Face</th><th></th></tr>
 ${rows.map(s=>`<tr><td>${esc(s.roll)}</td><td>${esc(s.name)}</td><td>${esc(s.course)}</td><td>${s.faces?`<span class="tag High">${s.faces} samples</span>`:'<span class="tag None">not enrolled</span>'}</td>
 <td><button class="btn sm" onclick="enroll(${s.id})">Enroll face</button> <button class="btn sm red" onclick="delStu(${s.id})">Delete</button></td></tr>`).join('')}</table></div></div>`;
}
function addStu(){
 const roll=$('nr').value.trim(),name=$('nn').value.trim();
 if(!roll||!name){$('smsg').textContent='Please fill roll number and name.';return}
 if(D.st.some(s=>s.roll.toLowerCase()===roll.toLowerCase())){$('smsg').textContent='That roll number already exists.';return}
 D.st.push({id:D.n++,roll,name,course:$('nc').value.trim(),marks:+$('nm').value||0,asg:+$('na').value||0,desc:[]});save();vStu();
}
function delStu(id){if(confirm('Delete this student and all their records?')){D.st=D.st.filter(s=>s.id!==id);D.at=D.at.filter(a=>a.sid!==id);save();vStu()}}
async function enroll(id){
 enrollId=id;$('modal').classList.add('open');$('mtitle').textContent='Enroll face: '+D.st.find(s=>s.id===id).name;$('capBtn').disabled=false;
 try{$('mmsg').textContent='Loading face models...';await models();mstream=await navigator.mediaDevices.getUserMedia({video:true});$('mcam').srcObject=mstream;
  $('mmsg').textContent='Face the camera in good light, then press Capture.'}
 catch(e){$('mmsg').textContent='Camera blocked or models failed to load.'}
}
async function capture(){
 if(!mstream)return;$('capBtn').disabled=true;const out=[];
 for(let i=0;i<8;i++){$('mmsg').textContent='Capturing '+(i+1)+'/8 - turn your head slightly';
  try{const r=await det($('mcam'));if(r)out.push(Array.from(r.descriptor))}catch(e){}await new Promise(r=>setTimeout(r,350))}
 if(out.length<3){$('mmsg').textContent='Face not clear. Use good light and face the camera.';$('capBtn').disabled=false;return}
 D.st.find(s=>s.id===enrollId).desc.push(...out);save();$('mmsg').textContent='Saved '+out.length+' face samples.';
 setTimeout(()=>{closeModal();vStu()},900);
}
function closeModal(){if(mstream)mstream.getTracks().forEach(t=>t.stop());mstream=null;$('modal').classList.remove('open')}
function vRec(){
 $('pane').innerHTML=`<div class="card"><h3>Attendance records</h3>
 <div class="row"><input type="date" id="rd" value="${today()}" onchange="loadRec()"><button onclick="$('rd').value='';loadRec()">All recent</button><button class="btn" onclick="exportCsv()">Export CSV</button></div>
 <div class="row"><select id="ms">${D.st.map(s=>`<option value="${s.id}">${esc(s.roll)} - ${esc(s.name)}</option>`).join('')}</select><button class="btn" onclick="manual()">Mark present (manual)</button></div>
 <div class="msg" id="rmsg" style="color:var(--bad)"></div><div class="scroll" id="rtable"></div></div>`;loadRec();
}
function loadRec(){
 const d=$('rd').value,rows=D.at.filter(a=>!d||a.day===d).sort((a,b)=>(b.day+b.time).localeCompare(a.day+a.time)).slice(0,300);
 $('rtable').innerHTML=rows.length?`<table><tr><th>Date</th><th>Time</th><th>Roll</th><th>Name</th><th>Method</th><th></th></tr>${rows.map(a=>{const s=D.st.find(x=>x.id===a.sid)||{roll:'?',name:'?'};
 return`<tr><td>${a.day}</td><td>${a.time}</td><td>${esc(s.roll)}</td><td>${esc(s.name)}</td><td>${a.method}</td><td><button class="btn sm red" onclick="delRec(${a.id})">X</button></td></tr>`}).join('')}</table>`:'<p style="color:var(--m)">No records for this selection.</p>';
}
function manual(){const sid=+$('ms').value;if(!sid)return;$('rmsg').textContent=mark(sid,'Manual',$('rd').value||undefined)?'':'Already marked for that day.';loadRec()}
function delRec(id){D.at=D.at.filter(a=>a.id!==id);save();loadRec()}
function exportCsv(){
 const lines=['Roll,Name,Date,Time,Method'].concat(D.at.map(a=>{const s=D.st.find(x=>x.id===a.sid)||{roll:'',name:''};return[s.roll,s.name,a.day,a.time,a.method].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')}));
 const l=document.createElement('a');l.href=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/csv'}));l.download='attendance.csv';l.click();
}
function vPred(){
 const rows=stats().rows;
 $('pane').innerHTML=`<div class="card"><h3>Student performance prediction</h3><p class="sub" style="margin-top:0">Score = 50% attendance + 30% marks + 20% assignments.</p><div class="scroll"><table><tr><th>Student</th><th>Attend.</th><th>Marks %</th><th>Assign. %</th><th>Score</th><th>Outlook</th><th>Advice</th><th></th></tr>
 ${rows.map(s=>`<tr><td>${esc(s.name)}<br><small style="color:var(--m)">${esc(s.roll)}</small></td><td>${s.pct}%</td><td><input class="mini" id="m${s.id}" type="number" value="${s.marks}"></td><td><input class="mini" id="a${s.id}" type="number" value="${s.asg}"></td>
 <td><b>${s.score}</b></td><td><span class="tag ${cls(s.label)}">${esc(s.label)}</span></td><td style="max-width:260px;font-size:13px">${esc(s.tip)}</td><td><button class="btn sm" onclick="saveScore(${s.id})">Save</button></td></tr>`).join('')}</table></div></div>`;
}
function saveScore(id){const s=D.st.find(x=>x.id===id);s.marks=+$('m'+id).value||0;s.asg=+$('a'+id).value||0;save();vPred()}
function vSet(){
 $('pane').innerHTML=`<div class="card" style="max-width:460px"><h3>Change admin password</h3><div class="row"><input id="op" type="password" placeholder="Current password"></div>
 <div class="row"><input id="np" type="password" placeholder="New password (6+ characters)"></div><div class="msg" id="pmsg"></div><button class="btn" onclick="chPw()">Update password</button>
 <p class="sub">Data is saved in this browser only. Use the same device and browser for admin work.</p></div>`;
}
async function chPw(){
 const m=$('pmsg');m.style.color='var(--bad)';
 if(await sha($('op').value)!==D.pw){m.textContent='Current password is wrong.';return}
 if($('np').value.length<6){m.textContent='New password needs 6+ characters.';return}
 D.pw=await sha($('np').value);save();m.style.color='var(--ok)';m.textContent='Password changed.';
}