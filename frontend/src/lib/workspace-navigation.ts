export const WORKSPACE_MODULES=[
 {id:'calendar',label:'日曆',href:'/calendar',description:'訂單、房況與日常入住安排。',enabled:true},
 {id:'conversations',label:'對話',href:'/conversations',description:'集中處理旅客訊息與對話。',enabled:false},
 {id:'marketing',label:'攬客',href:'/marketing',description:'經營客源、行銷與回訪。',enabled:false},
 {id:'competitors',label:'競品',href:'/competitors',description:'掌握市場與周邊旅宿動態。',enabled:false},
 {id:'finance',label:'財務',href:'/finance',description:'記錄收支，掌握營運花費。',enabled:true},
 {id:'settings',label:'設定',href:'/settings',description:'個人偏好、帳號與權限管理。',enabled:true},
] as const;
export const maySeeFinance=(role:string|undefined)=>['owner','god','admin'].includes(role??'');
