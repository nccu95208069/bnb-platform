// Local Android Emulator API; credentials and clipboard contents never leave this process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http2 from 'node:http2';
import {execFileSync} from 'node:child_process';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!/^emulator-\d+$/.test(input.serial) || typeof input.text !== 'string' || input.text.length > 2000) throw Error('invalid_clipboard_request');
const directory = path.join(os.homedir(), 'Library/Caches/TemporaryItems/avd/running');
const configs = fs.readdirSync(directory).filter(n => /^pid_\d+\.ini$/.test(n)).map(n => {
  const raw = fs.readFileSync(path.join(directory, n), 'utf8');
  return Object.fromEntries(raw.split('\n').filter(x => x.includes('=')).map(x => { const i=x.indexOf('='); return [x.slice(0,i), x.slice(i+1)]; }));
}).filter(c => c['port.serial'] === input.serial.slice(9) && /^\d+$/.test(c['grpc.port'] || '') && c['grpc.token']);
if (configs.length !== 1) throw Error('emulator_clipboard_unavailable');
const config = configs[0];
const session = http2.connect('http://127.0.0.1:' + config['grpc.port']);
function rpc(method, body = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const frame=Buffer.alloc(5); frame.writeUInt32BE(body.length,1);
    const req=session.request({':method':'POST', ':path':'/android.emulation.control.EmulatorController/'+method,
      'content-type':'application/grpc', te:'trailers', authorization:'Bearer '+config['grpc.token']});
    let status, size=0; const chunks=[];
    req.setTimeout(5000,()=>req.destroy(new Error('clipboard_timeout')));
    req.on('response',h=>{if(h['grpc-status']!==undefined)status=h['grpc-status'];});
    req.on('trailers',h=>{status=h['grpc-status'];});
    req.on('data',b=>{size+=b.length;if(size>1048576)req.destroy(new Error('clipboard_too_large'));else chunks.push(b);});
    req.on('error',reject);
    req.on('end',()=>{const data=Buffer.concat(chunks);if(String(status)!=='0')return reject(new Error('clipboard_rpc_failed'));
      if(data.length<5||data[0]!==0||data.readUInt32BE(1)!==data.length-5)return reject(new Error('clipboard_invalid_frame'));
      resolve(data.subarray(5));});
    req.end(Buffer.concat([frame,body]));
  });
}
const adb=(...args)=>execFileSync(input.adb,['-s',input.serial,'shell','input',...args],{stdio:'pipe',timeout:8000});
try {
  const original=await rpc('getClipboard');
  if (!input.probe) {
    const text=Buffer.from(input.text,'utf8'), length=[]; let n=text.length;
    while(n>127){length.push((n&127)|128);n>>>=7;} length.push(n);
    try {
      await rpc('setClipboard',Buffer.concat([Buffer.from([10,...length]),text]));
      await new Promise(resolve=>setTimeout(resolve,300));
      if(input.replace)adb('keycombination','KEYCODE_CTRL_LEFT','KEYCODE_A');
      adb('keyevent', input.replace && !input.text ? '67' : '279');
      await new Promise(resolve=>setTimeout(resolve,400));
    } finally {await rpc('setClipboard',original);}
  }
  process.stdout.write('{"ok":true}');
} catch {process.stderr.write('emulator_clipboard_failed');process.exitCode=1;}
finally {session.close();}
