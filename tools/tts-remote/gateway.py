"""Authenticated, allowlisted gateway for the existing loopback-only DXL1 studio."""
import secrets,re,time,json,os
from pathlib import Path
from collections import deque
import httpx
from fastapi import FastAPI,Request
from fastapi.responses import Response,JSONResponse
from fastapi.middleware.cors import CORSMiddleware
ROOT=Path(__file__).resolve().parent
TOKEN=(ROOT/'access-key.txt').read_text(encoding='utf-8').strip()
if len(TOKEN)<40:raise RuntimeError('A strong access key is required')
app=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
app.add_middleware(CORSMiddleware,allow_origins=['http://tauri.localhost','https://tauri.localhost','tauri://localhost','https://localhost','http://localhost'],allow_origin_regex=r'https?://(localhost|127\.0\.0\.1)(:[0-9]+)?',allow_methods=['GET','POST'],allow_headers=['Authorization','Content-Type','X-Local-Token'])
recent=deque()
def allowed(method,path):
 return (method=='GET' and (path in ('/health','/api/session') or re.fullmatch(r'/api/jobs/[0-9a-f]{32}',path) or re.fullmatch(r'/audio/[0-9a-f]{32}/(original|rvc-050|rvc-075)\.wav',path))) or (method=='POST' and (path=='/api/generate' or re.fullmatch(r'/api/jobs/[0-9a-f]{32}/cancel',path)))
@app.api_route('/{path:path}',methods=['GET','POST','PUT','DELETE','PATCH'])
async def proxy(request:Request,path:str):
 auth=request.headers.get('authorization','')
 if not secrets.compare_digest(auth,'Bearer '+TOKEN):return JSONResponse({'detail':'Access key required'},401,headers={'Cache-Control':'no-store'})
 route='/'+path
 if not allowed(request.method,route):return JSONResponse({'detail':'Not available remotely'},404)
 body=bytearray()
 async for chunk in request.stream():
  body.extend(chunk)
  if len(body)>16384:return JSONResponse({'detail':'Request too large'},413)
 if request.method=='POST' and route=='/api/generate':
  now=time.monotonic()
  while recent and recent[0]<now-60:recent.popleft()
  if len(recent)>=20:return JSONResponse({'detail':'Too many synthesis requests; wait a minute'},429)
  recent.append(now)
 try:
  async with httpx.AsyncClient(base_url='http://127.0.0.1:9884',timeout=20,trust_env=False,follow_redirects=False) as client:
   headers={}
   if request.method=='POST':
    session=await client.get('/api/session');session.raise_for_status()
    headers={'X-Local-Token':session.json()['token'],'Content-Type':'application/json'}
   response=await client.request(request.method,route,content=bytes(body),headers=headers)
   if route=='/api/session' and response.status_code==200:
    data=response.json();return JSONResponse({'token':'remote-authenticated','base_prompt':data['base_prompt']},headers={'Cache-Control':'no-store'})
   return Response(response.content,status_code=response.status_code,media_type=response.headers.get('content-type','application/json'),headers={'Cache-Control':'no-store'})
 except Exception:return JSONResponse({'detail':'Local DXL1 service unavailable'},502,headers={'Cache-Control':'no-store'})
if __name__=='__main__':
 import uvicorn
 (ROOT/'gateway.pid').write_text(str(os.getpid()))
 uvicorn.run(app,host='127.0.0.1',port=9885,access_log=False)
