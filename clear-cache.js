
// Clear require cache para forçar reload
Object.keys(require.cache).forEach(key => {
  if (key.includes('limitMakerEntry') || key.includes('api.js')) {
    delete require.cache[key];
  }
});
