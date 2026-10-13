const webConfig = {
    apiUrl: process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:8000' : '',
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
    // 版本更新检查的数据来源仓库（owner/repo），默认为本 fork
    updateRepo: process.env.NEXT_PUBLIC_UPDATE_REPO || 'tcatche/chatgpt2api',
}

export default webConfig
