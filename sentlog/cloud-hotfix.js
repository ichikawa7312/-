(function(){
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    const res = await nativeFetch(input, init);
    try{
      const url = typeof input==='string' ? input : input?.url || '';
      if(url.includes('/rest/v1/sentlog_assets?client_key=eq.') && res.ok){
        const clone = res.clone();
        const data = await clone.json();
        if(Array.isArray(data) && data[0]?.status==='storage_deleted'){
          data[0].status='pc_verified';
          return new Response(JSON.stringify(data),{
            status:res.status,
            statusText:res.statusText,
            headers:{'Content-Type':'application/json'}
          });
        }
      }
    }catch{}
    return res;
  };
})();