(()=>{'use strict';
  const isArabic=()=>String(document.documentElement.lang||'').toLowerCase()==='ar';
  const setButtonLabel=()=>{
    const button=document.getElementById('languageToggle');
    if(!button)return;
    const arabic=isArabic();
    button.textContent=arabic?'EN':'العربية';
    const label=arabic?'Switch to English':'التبديل إلى العربية';
    button.setAttribute('aria-label',label);
    button.title=label;
  };
  const switchLanguage=()=>{
    const arabic=isArabic();
    const current=new URL(window.location.href);
    const path=current.pathname;
    const lowerPath=path.toLowerCase();
    const isKnownPage=['/index.html','/index-en.html','/index-ar.html'].some(name=>lowerPath.endsWith(name))||['index.html','index-en.html','index-ar.html'].includes(lowerPath);
    const base=isKnownPage?path.slice(0,path.lastIndexOf('/')+1):(path.endsWith('/')?path:path.slice(0,path.lastIndexOf('/')+1)||'/');
    const target=new URL(base+(arabic?'index.html':'index-ar.html'),current.origin);
    target.search=current.search;
    target.hash=current.hash;
    try{
      const view=document.querySelector('.view.active')?.id?.replace(/^view-/,'')||'dashboard';
      const fields={};
      document.querySelectorAll('input[id],select[id],textarea[id]').forEach(el=>{
        if(el.type!=='password')fields[el.id]=el.value;
      });
      sessionStorage.setItem('smartnote-language-switch-state',JSON.stringify({view,fields,scrollY:window.scrollY}));
      localStorage.setItem('smartnote-language-view',view);
      localStorage.setItem('aqarLanguage',arabic?'en':'ar');
    }catch(error){console.warn('Could not preserve state while changing language:',error)}
    window.location.assign(target.href);
  };
  const bind=()=>{
    setButtonLabel();
    document.addEventListener('click',event=>{
      const button=event.target.closest?.('#languageToggle');
      if(!button)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      switchLanguage();
    },true);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});
  else bind();
})();