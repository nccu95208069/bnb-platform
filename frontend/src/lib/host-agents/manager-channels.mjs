export const clearLabels={all:'全部標為已處理',line:'LINE 全部標為已處理',instagram:'IG 全部標為已處理'};
export const channelLabel=channel=>({all:'所有渠道',line:'LINE',instagram:'IG'})[channel];
export const validChannel=channel=>typeof channel==='string'&&Object.hasOwn(clearLabels,channel);
// Drafts created before channel metadata was introduced are LINE drafts.
export const matchesChannel=(draft,channel)=>channel==='all'||(draft.channel_kind||'line')===channel;
