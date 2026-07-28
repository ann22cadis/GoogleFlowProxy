function injectIframe() {
  if (!document.getElementById('labs-iframe')) {
    console.log('[Flow] Injecting Google Labs iframe (Anti-Sleep Mode) into', window.location.href);
    const iframe = document.createElement('iframe');
    iframe.id = 'labs-iframe';
    iframe.src = 'https://labs.google/fx/tools/flow';
    // 1x1 pixel, invisible, fixed to bottom-right, pointer-events: none so it doesn't block clicks
    iframe.style.cssText = 'width: 1px; height: 1px; opacity: 0; position: fixed; bottom: 0; right: 0; pointer-events: none; z-index: -9999;';
    
    // Allow permissions if needed by some Web API calls in the iframe
    iframe.allow = "camera; microphone";
    
    document.body.appendChild(iframe);
  } else {
    console.log('[Flow] Labs iframe is already injected.');
  }
}

// Wait for the page to fully load before injecting to avoid delaying SillyTavern's startup
if (document.readyState === 'complete') {
  setTimeout(injectIframe, 2000);
} else {
  window.addEventListener('load', () => setTimeout(injectIframe, 2000));
}
