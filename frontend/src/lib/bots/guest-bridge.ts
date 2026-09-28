import {withWorkspace} from './persistence';
import {guestConfig,saveGuestKnowledge,runGuestAgent,recordGuestEvent,resolveGuestEvents} from './guest-agent.mjs';

export const guestBridge={
 config:(botId:string,property='sweetfun')=>withWorkspace(async s=>guestConfig(s,botId,property),false),
 knowledge:(input:Record<string,unknown>,property='sweetfun')=>withWorkspace(async s=>input.save===true?saveGuestKnowledge(s,input,property):guestConfig(s,'concierge',property).knowledge,input.save===true),
 plan:async (botId:string,input:Parameters<typeof runGuestAgent>[1],property='sweetfun')=>{
  const config=await withWorkspace(async s=>guestConfig(s,botId,property),false);
  return runGuestAgent(config,input);
 },
 record:(event:Parameters<typeof recordGuestEvent>[1])=>withWorkspace(async s=>recordGuestEvent(s,event),true),
 resolve:(guestRef:string)=>withWorkspace(async s=>resolveGuestEvents(s,guestRef),true),
};
