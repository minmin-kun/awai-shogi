export const QUOTA_CODE='SERVICE_QUOTA_EXCEEDED';
export function quotaPayload(limit='daily',now=Date.now()){
 const date=new Date(now);
 return {code:QUOTA_CODE,limit,error:limit==='daily'?'本日の利用上限に達しました。':'サーバーの保存容量が上限に達しました。',resetAt:limit==='daily'?Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+1):null};
}
export function quotaFromPayload(value){
 if(value?.code!==QUOTA_CODE||!['daily','storage'].includes(value.limit))return null;
 return {...quotaPayload(value.limit),...(value.limit==='daily'&&Number.isFinite(value.resetAt)?{resetAt:value.resetAt}:{})};
}
export function quotaFromFailure(error){
 const structured=quotaFromPayload(error);if(structured)return structured;
 let message='',cause=error;
 for(let i=0;i<3&&cause;i++,cause=cause.cause)message+=' '+String(cause.message||cause);
 if(/exceeded D1's free tier daily row (?:read|write) limit/i.test(message))return quotaPayload();
 if(/Exceeded maximum DB size|exceeded D1's maximum account storage limit/i.test(message))return quotaPayload('storage');
 return null;
}
export function serviceError(payload,status){return Object.assign(new Error(payload.error||'接続できませんでした。'),payload,{status});}
export async function readServiceResponse(response){
 const text=await response.text();
 if(!response.ok&&/\berror(?:\s+code)?\s*:?\s*1027\b/i.test(text.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ')))throw serviceError(quotaPayload(),response.status);
 let data;try{data=JSON.parse(text);}catch{throw Object.assign(new Error('サーバーに接続できませんでした。'),{status:response.status});}
 const quota=quotaFromPayload(data);if(quota)throw serviceError(quota,response.status);
 if(!response.ok)throw serviceError({error:data.error||'接続できませんでした。'},response.status);
 return data;
}
export function quotaCopy(quota,hasRoom=false){
 const daily=quota.limit==='daily';
 const reset=daily?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(quota.resetAt)):null;
 return {
  title:daily?'本日の利用上限に達しました':'サーバーの保存容量が上限に達しました',
  message:'このサイトはCloudflareのサーバーとデータベースの無料枠で運用しています。'+(daily?'本日の利用上限に達したため、現在、オンライン対局をご利用いただけません。':'保存容量が上限に達したため、現在、オンライン対局をご利用いただけません。'),
  recovery:daily?`利用枠は${reset}（日本時間）にリセットされ、それ以降は再び利用できる見込みです。その時刻を過ぎてから、このページを再読み込みしてください。`:'利用再開の時刻は未定です。運営側での対応が必要なため、時間をおいて、このページを再読み込みしてください。',
  note:hasRoom?'対局の参加情報はこのタブに残しています。ただし、復旧後も対局を再開できない場合があります。':'CPUとの対局は引き続き遊べます。'
 };
}
