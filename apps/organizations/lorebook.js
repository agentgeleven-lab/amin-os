import {installUpdateEntry} from '../status/lorebook.js';
import {followPrompt} from './ai.js';
import {isIndependent} from '../story-state/access.js';
export const MARKER='amin-os/organizations-v1';
export async function syncWorldbook(api,options={}){
 if(isIndependent(api.context()))throw Error('独立剧情模式由插件直接提供统一更新规则，无需同步世界书；现有世界书条目不会被改写。');
 const token=api.capture(),config=api.config();
 return installUpdateEntry({context:api.context,check:()=>api.check(token),...options,entryOptions:{ownerField:'amin_organizations_owner',marker:MARKER,title:'势力概览 · 变量更新规则',prompt:followPrompt(config,token.locks),backupKey:'amin_organizations_lorebook_backups',enabled:config.follow}});
}
