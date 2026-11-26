function page(title: string, body: string, script: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f8f9f4;color:#1c3029;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:820px;margin:auto;padding:36px 24px}h1{font-size:30px;letter-spacing:-1px;margin:10px 0}p{color:#738077;line-height:1.7}label{display:block;font-size:13px;margin:14px 0 7px}input,select{width:100%;border:1px solid #dce2d9;border-radius:10px;padding:12px;background:white;font:inherit;color:#1c3029}button{border:0;border-radius:10px;padding:12px 16px;background:#173f35;color:white;font:inherit;cursor:pointer}button.secondary{background:#edf1e7;color:#325c4a}button.danger{background:#fae9e7;color:#9b453c}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #c9e48d;outline-offset:2px}.row{display:flex;gap:10px;align-items:center}.row input{flex:1;min-width:0}.row select{width:130px}.panel{padding:22px;background:white;border:1px solid #e1e7dd;border-radius:18px;margin:20px 0}.item{display:flex;gap:12px;align-items:center;padding:15px 0;border-bottom:1px solid #edf0e9}.item:last-child{border:0}.item .name{flex:1;overflow-wrap:anywhere}.item select{width:116px;padding:8px}.item button{padding:8px 10px;font-size:12px}.meta{font-size:12px;color:#879083}.badge{display:inline-block;background:#edf3de;color:#41612c;padding:6px 10px;border-radius:6px;font-size:11px;letter-spacing:1px}.empty{padding:32px;text-align:center;color:#849285}.stats{display:flex;gap:12px}.stat{flex:1;padding:20px;background:#173f35;color:white;border-radius:14px}.stat small{color:#b5c9b6}.stat strong{display:block;font-size:30px;margin-top:10px}#save-status{font-size:12px;color:#7b877d;min-height:18px}@media(max-width:560px){main{padding:24px 16px}.row{flex-wrap:wrap}.row input{flex-basis:100%}.item{flex-wrap:wrap}.item .name{flex-basis:100%}.stats{flex-direction:column}}
</style></head><body><main><span class="badge">INTERACTIVE APP</span>${body}<p id="save-status" role="status">正在读取已保存的数据…</p></main><script>${script}</script></body></html>`;
}

const taskHtml = page('项目待办看板', `<h1>每一个想法，都向前一步。</h1><p>把项目拆成小任务，专注于下一件事。</p><section class="panel"><label for="task-name">任务名称</label><div class="row"><input id="task-name" placeholder="下一件想完成的事" maxlength="120"><select id="task-priority" aria-label="任务优先级"><option value="普通">普通优先级</option><option value="高">高优先级</option><option value="低">低优先级</option></select><button id="add">添加任务</button></div></section><div class="stats"><div class="stat"><small>全部任务</small><strong id="total">0</strong></div><div class="stat"><small>已完成</small><strong id="done">0</strong></div></div><section class="panel" id="list"></section>`, `
(async () => {
let state = await window.atoms.loadState();
if(!Array.isArray(state.tasks)) state={tasks:[]};
const status=document.getElementById('save-status');
async function save(){status.textContent='保存中…';try{await window.atoms.saveState(state);status.textContent='已保存，刷新后也在';}catch(e){status.textContent='未保存：'+e.message;}}
function render(){
 const list=document.getElementById('list');list.replaceChildren();
 document.getElementById('total').textContent=String(state.tasks.length);
 document.getElementById('done').textContent=String(state.tasks.filter(t=>t.status==='已完成').length);
 if(!state.tasks.length){const p=document.createElement('p');p.className='empty';p.textContent='添加第一条任务，开始你的项目';list.append(p);}
 state.tasks.forEach(task=>{
  const row=document.createElement('div');row.className='item';
  const name=document.createElement('span');name.className='name';name.textContent=task.name+' · '+task.priority+'优先级';if(task.status==='已完成')name.style.textDecoration='line-through';
  const select=document.createElement('select');select.setAttribute('aria-label',task.name+'的状态');['待办','进行中','已完成'].forEach(value=>{const o=document.createElement('option');o.value=value;o.textContent=value;select.append(o);});select.value=task.status;
  select.onchange=()=>{task.status=select.value;render();save();};
  const complete=document.createElement('button');complete.className='secondary';complete.textContent=task.status==='已完成'?'重新打开':'标记完成';complete.onclick=()=>{task.status=task.status==='已完成'?'待办':'已完成';render();save();};
  const remove=document.createElement('button');remove.className='danger';remove.textContent='删除';remove.setAttribute('aria-label','删除'+task.name);remove.onclick=()=>{state.tasks=state.tasks.filter(t=>t.id!==task.id);render();save();};row.append(name,select,complete,remove);list.append(row);
 });
}
function add(){const input=document.getElementById('task-name');const name=input.value.trim();if(!name)return;state.tasks.push({id:Date.now().toString(36)+Math.random().toString(36).slice(2),name,priority:document.getElementById('task-priority').value,status:'待办'});input.value='';render();save();}
document.getElementById('add').onclick=add;document.getElementById('task-name').onkeydown=e=>{if(e.key==='Enter')add();};render();status.textContent='数据已恢复';
})();`);

const calculatorHtml = page('房贷月供计算器', `<h1>把未来的每一笔，算清楚。</h1><p>等额本息月供估算。结果仅供参考，不构成贷款建议。</p><section class="panel"><label for="loan">贷款金额（元）</label><input id="loan" type="number" min="1" value="500000"><label for="rate">年利率（%）</label><input id="rate" type="number" min="0" max="30" step="0.1" value="3.5"><label for="years">贷款年限</label><input id="years" type="number" min="1" max="50" value="30"><button id="calculate" style="margin-top:18px">计算并保存</button></section><div class="stats"><div class="stat"><small>每月还款</small><strong id="monthly">—</strong></div><div class="stat"><small>总利息</small><strong id="interest">—</strong></div></div>`, `
(async()=>{
const state=await window.atoms.loadState();const ids=['loan','rate','years'];const fallback={loan:500000,rate:3.5,years:30};ids.forEach(id=>document.getElementById(id).value=state[id]??fallback[id]);
const status=document.getElementById('save-status');
async function calculate(persist){const data={};ids.forEach(id=>data[id]=Number(document.getElementById(id).value));if(!(data.loan>0&&data.rate>=0&&data.rate<=30&&data.years>=1&&data.years<=50)){status.textContent='请检查贷款金额、利率和年限';return;}
const r=data.rate/1200,n=data.years*12;const monthly=r===0?data.loan/n:data.loan*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1);document.getElementById('monthly').textContent='¥ '+monthly.toFixed(2);document.getElementById('interest').textContent='¥ '+(monthly*n-data.loan).toFixed(2);
if(persist){status.textContent='保存中…';try{await window.atoms.saveState(data);status.textContent='参数已保存';}catch(e){status.textContent='未保存：'+e.message;}}}
document.getElementById('calculate').onclick=()=>calculate(true);await calculate(false);status.textContent='参数已恢复';
})();`);

const habitHtml = page('每日习惯记录', `<h1>小小坚持，慢慢发生。</h1><p>为今天留下一点进步，明天继续。</p><section class="panel"><label for="habit-name">习惯名称</label><div class="row"><input id="habit-name" placeholder="例如：阅读 20 分钟" maxlength="100"><button id="add-habit">添加习惯</button></div></section><div class="stat"><small>今日完成率</small><strong id="progress">0%</strong></div><section class="panel" id="habits"></section>`, `
(async()=>{
let state=await window.atoms.loadState();if(!Array.isArray(state.habits))state={habits:[]};const today=new Date().toLocaleDateString('sv-SE');const status=document.getElementById('save-status');
async function save(){status.textContent='保存中…';try{await window.atoms.saveState(state);status.textContent='今日记录已保存';}catch(e){status.textContent='未保存：'+e.message;}}
function render(){const list=document.getElementById('habits');list.replaceChildren();let done=0;state.habits.forEach(h=>{if(!Array.isArray(h.days))h.days=[];const checked=h.days.includes(today);if(checked)done++;const row=document.createElement('div');row.className='item';const label=document.createElement('span');label.className='name';label.textContent=h.name;const button=document.createElement('button');button.className=checked?'secondary':'';button.textContent=checked?'取消打卡':'今日打卡';button.onclick=()=>{h.days=checked?h.days.filter(d=>d!==today):[...h.days,today];render();save();};const remove=document.createElement('button');remove.className='danger';remove.textContent='删除';remove.onclick=()=>{state.habits=state.habits.filter(x=>x.id!==h.id);render();save();};row.append(label,button,remove);list.append(row);});if(!state.habits.length){const p=document.createElement('p');p.className='empty';p.textContent='从一个小习惯开始';list.append(p);}document.getElementById('progress').textContent=(state.habits.length?Math.round(done/state.habits.length*100):0)+'%';}
function add(){const input=document.getElementById('habit-name');const name=input.value.trim();if(!name)return;state.habits.push({id:Date.now().toString(36)+Math.random().toString(36).slice(2),name,days:[]});input.value='';render();save();}
document.getElementById('add-habit').onclick=add;document.getElementById('habit-name').onkeydown=e=>{if(e.key==='Enter')add();};render();status.textContent='习惯已恢复';
})();`);

export function getExampleHtml(prompt: string): string {
  if (/房贷|月供|计算器|calculator|mortgage/i.test(prompt)) return calculatorHtml;
  if (/习惯|打卡|habit/i.test(prompt)) return habitHtml;
  return taskHtml;
}
