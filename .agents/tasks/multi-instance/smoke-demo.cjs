// Demo PM2 process for the hub-and-spoke smoke: logs a line every second so the
// live-log relay has something to stream.
setInterval(() => {
  console.log(`smoke-demo tick ${new Date().toISOString()}`);
}, 1000);
