import React, {useEffect, useState} from 'react';

/** A save warning only; no unlock service, migration dialog or recovery workflow. */
export function CredentialStorageNotice() {
  const [notice,setNotice]=useState('');
  useEffect(()=>{
    const api=window.electronAPI;
    if(!api?.settings?.credentialStatus)return;
    let live=true;
    const refresh=()=>api.settings.credentialStatus().then(status=>{
      if(!live)return;
      setNotice(status.mode==='normal'?'':status.mode==='reconfigure'
        ? '旧加密配置已跳过，请重新添加。其他配置正常存储，只有密码和密钥使用 Windows 密码保护。'
        : '密码暂时无法读取或保存，软件仍可使用。本次修改仅在当前会话生效，原始配置已保留。');
    }).catch(()=>{});
    void refresh();const timer=setInterval(refresh,2000);
    const offSettings=api.settings.onSettingsChanged?.(()=>{void refresh();});
    const offNodes=api.nodes.onNodesChanged?.(()=>{void refresh();});
    return()=>{live=false;clearInterval(timer);offSettings?.();offNodes?.();};
  },[]);
  return notice?<div role="alert" className="mx-6 mt-2 px-4 py-3 rounded-xl text-sm border border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 no-drag">{notice}</div>:null;
}
