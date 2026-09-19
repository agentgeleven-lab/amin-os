import {installUpdateEntry} from '../status/lorebook.js';
import {followPrompt} from './ai.js';
export const MARKER='amin-os/organizations-v1';
export async function syncWorldbook(api,options={}){
 const token=api.capture(),config=api.config();
 return installUpdateEntry({context:api.context,check:()=>api.check(token),...options,entryOptions:{ownerField:'amin_organizations_owner',marker:MARKER,title:'势力概览 · 变量更新规则',prompt:followPrompt(config,token.locks),backupKey:'amin_organizations_lorebook_backups',enabled:config.follow}});
}
