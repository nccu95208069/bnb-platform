import net from 'node:net';
// Local integration tests only. Never accepts a remote host or production credentials.
export function localRedis(command) {
  const port = Number(process.env.CALENDAR_TEST_REDIS_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('local Redis test port required');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host:'127.0.0.1',port});
    let data = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(Error('Redis test timeout')));
    socket.on('error',reject);
    socket.on('connect',() => socket.write(Buffer.concat([Buffer.from(`*${command.length}\r\n`),...command.flatMap(value=>{const s=Buffer.from(String(value));return [Buffer.from(`$${s.length}\r\n`),s,Buffer.from('\r\n')];})])));
    const parse = (at=0) => {
      const end=data.indexOf('\r\n',at); if(end<0) return;
      const type=String.fromCharCode(data[at]), line=data.subarray(at+1,end).toString(), start=end+2;
      if(type==='-') throw Error(line);
      if(type==='+') return [line,start];
      if(type===':') return [Number(line),start];
      if(type==='$'){const n=Number(line);if(n===-1)return [null,start];if(data.length<start+n+2)return;return [data.subarray(start,start+n).toString(),start+n+2];}
      if(type==='*'){const n=Number(line);if(n===-1)return [null,start];const array=[];let next=start;for(let i=0;i<n;i++){const value=parse(next);if(!value)return;array.push(value[0]);next=value[1];}return [array,next];}
      throw Error('unsupported Redis response');
    };
    socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);try{const value=parse();if(value){socket.end();resolve(value[0]);}}catch(e){socket.destroy();reject(e);}});
  });
}
