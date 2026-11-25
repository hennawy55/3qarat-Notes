(()=>{'use strict';
  const isArabic=()=>document.documentElement.lang.toLowerCase()==='ar'||/(?:^|\\/)index-ar\\.html$/i.test(window.location.pathname);
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
    let base;
    if(/\\/index(?:-ar|-en)?\\.html$/i.test(path))base=path.replace(/index(?:-ar|-en)?\\.html$/i,'');
    else if(path.endsWith('/'))base=path;
    else base=path.slice(0,path.lastIndexOf('/')+1)||'/';
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
    // Delegation in capture phase keeps the switch reliable even if app code rebinds UI handlers.
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