/* Small private change notifications. Record contents always use the authenticated CAS API. */
(function(root){
  'use strict';
  function create({url,key,session,enabled,onChange,onReady=()=>{},Socket=root.WebSocket,
    setTimer=setTimeout,clearTimer=clearTimeout,random=Math.random}){
    let socket=null,owner='',token='',topic='',generation=0,sequence=0,joinRef='',heartbeatRef='',
      timer=null,heartbeat=null,joinTimeout=null,failures=0,joined=false,stopped=false;
    const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const clear=()=>{for(const t of [timer,heartbeat,joinTimeout])if(t!==null)clearTimer(t);timer=heartbeat=joinTimeout=null;};
    function close(){
      generation++;clear();joined=false;heartbeatRef='';
      const old=socket;socket=null;if(old){old.onopen=old.onmessage=old.onerror=old.onclose=null;try{old.close();}catch(_){}}
    }
    function send(event,payload={},channel=topic,ref=String(++sequence)){
      if(!socket||socket.readyState!==1)return null;
      socket.send(JSON.stringify({topic:channel,event,payload,ref,join_ref:channel===topic?joinRef:null}));return ref;
    }
    function reconnect(){
      close();if(stopped||!enabled())return;
      const delay=Math.min(30000,1000*2**Math.min(failures++,5))*(.8+random()*.4);
      timer=setTimer(()=>{timer=null;wake();},delay);
    }
    function beat(){
      heartbeat=null;if(!joined)return;
      if(heartbeatRef){reconnect();return;}
      heartbeatRef=send('heartbeat',{},'phoenix');
      heartbeat=setTimer(beat,20000);
    }
    function wake(){
      if(stopped)return;
      const s=session(),nextOwner=s?.user?.id||'',nextToken=s?.access_token||'';
      if(!enabled()||!uuid(nextOwner)||!nextToken||!Socket){close();owner=nextOwner;token=nextToken;return;}
      if(owner!==nextOwner){close();failures=0;owner=nextOwner;}
      if(socket){
        if(token!==nextToken){token=nextToken;if(joined)send('access_token',{access_token:token});}
        return;
      }
      if(timer!==null)return;
      token=nextToken;topic='realtime:sentlog-records:'+owner;joinRef=String(++sequence);
      const epoch=++generation;
      try{socket=new Socket(url.replace(/^http/,'ws').replace(/\/$/,'')+'/realtime/v1/websocket?apikey='+encodeURIComponent(key)+'&vsn=1.0.0');}
      catch(_){reconnect();return;}
      const active=()=>!stopped&&epoch===generation&&owner===session()?.user?.id&&enabled();
      socket.onopen=()=>{
        if(epoch!==generation)return;
        if(!active()){close();return;}
        send('phx_join',{access_token:token,config:{private:true,broadcast:{ack:false,self:false},presence:{enabled:false},postgres_changes:[]}},topic,joinRef);
        joinTimeout=setTimer(()=>{joinTimeout=null;reconnect();},12000);
      };
      socket.onmessage=e=>{
        if(epoch!==generation)return;
        if(!active()){close();return;}
        let m;try{m=JSON.parse(e.data);}catch(_){return;}
        if(!m||typeof m!=='object')return;
        if(m.topic==='phoenix'&&m.event==='phx_reply'&&m.ref===heartbeatRef){heartbeatRef='';return;}
        if(m.topic!==topic||(m.join_ref&&m.join_ref!==joinRef))return;
        if(m.event==='phx_reply'&&m.ref===joinRef){
          if(m.payload?.status!=='ok'){reconnect();return;}
          if(joinTimeout!==null)clearTimer(joinTimeout);joinTimeout=null;joined=true;failures=0;
          if(heartbeat!==null)clearTimer(heartbeat);heartbeat=setTimer(beat,20000);onReady();return;
        }
        if(m.event==='phx_error'||m.event==='phx_close'){reconnect();return;}
        if(!joined||m.event!=='broadcast'||!['records','asset'].includes(m.payload?.event))return;
        const value=m.payload.payload;if(!value||!uuid(value.project_id))return;
        if(m.payload.event==='records'&&(!Number.isSafeInteger(Number(value.revision))||Number(value.revision)<1))return;
        onChange({kind:m.payload.event,projectId:value.project_id,revision:Number(value.revision)||0});
      };
      socket.onerror=()=>{if(epoch===generation)reconnect();};
      socket.onclose=()=>{if(epoch===generation)reconnect();};
    }
    return {wake,stop(){stopped=true;close();},get connected(){return joined;}};
  }
  const api={create};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SentlogCollaborationChannel=api;
})(typeof window!=='undefined'?window:globalThis);
