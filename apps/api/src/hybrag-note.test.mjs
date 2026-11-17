import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { provisionVosUser } from "./vos-auth.ts";
import { createMemoRecord } from "./memo-service.ts";
import { mintHybragNoteTicket, redeemHybragNoteTicket, registerHybragNoteRoutes } from "./hybrag-note.ts";
import { registerHybragSettingsRoutes } from "./hybrag-settings.ts";
import { registerHybragManualRoutes } from "./hybrag-manual.ts";
import { deliverHybragControl, redeemHybragControl } from "./hybrag-control.ts";
import { saveHybragDelegation, readHybragDelegation, readVerifiedHybragDelegation, beginHybragDelegationRevocation, finishHybragDelegationRevocation } from "./hybrag-delegation-store.ts";
import { enableHybragDelegation, maintainHybragDelegations, registerHybragDelegationRoutes } from "./hybrag-delegation.ts";
import { registerHybragSourceRoutes } from "./hybrag-source.ts";

const resources = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });

const fixture = async (upgrade = false) => {
  const database = new Database(":memory:");
  resources.push(() => database.close());
  const migrations = globSync("migrations/*.sql").sort();
  for (const name of migrations) {
    if (upgrade && Number.parseInt(name.split("/").at(-1),10)>=94) continue;
    database.exec(readFileSync(name, "utf8"));
  }
  const directory = mkdtempSync(join(tmpdir(), "vnote-hybrag-note-"));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const storage = createSelfHostedStorageAdapter(database, directory);
  const owner = await provisionVosUser(storage.db, { subject: "owner-sub", username: "owner", displayName: "Owner", role: "owner" });
  const workspace = database.query("SELECT workspace_id FROM workspace_members WHERE user_id = ?").get(owner.user.id).workspace_id;
  const identity = { userId: owner.user.id, workspaceId: workspace, subject: "owner-sub" };
  database.query("INSERT INTO notebooks(id,workspace_id,name,parent_id) VALUES (?,?,?,?)").run("root", workspace, "Root", null);
  database.query("INSERT INTO notebooks(id,workspace_id,name,parent_id) VALUES (?,?,?,?)").run("child", workspace, "Child", "root");
  database.query("INSERT INTO notebooks(id,workspace_id,name,parent_id) VALUES (?,?,?,?)").run("outside", workspace, "Outside", null);
  const create = (body = "正文 with `a < b`", notebook = "child") => createMemoRecord(storage.db, workspace,
    { notebookId: notebook, title: "A title", contentMarkdown: body }, { actorType: "user", actorId: owner.user.id }, owner.user.id);
  const note = await create();
  if (upgrade) for (const name of migrations.filter((name) => Number.parseInt(name.split("/").at(-1),10)>=94)) database.exec(readFileSync(name, "utf8"));
  database.query("INSERT INTO hybrag_settings(user_id,workspace_id,enabled,roots_json) VALUES (?,?,1,?)").run(owner.user.id, workspace, JSON.stringify(["root"]));
  database.query("INSERT INTO hybrag_control_delivery(user_id,workspace_id,acknowledged_version) VALUES (?,?,1)").run(owner.user.id, workspace);
  const userinfo = Bun.serve({ port: 0, fetch(request) {
    return Response.json({ sub: request.headers.get("authorization") === "Bearer other-proof" ? "other-sub" : "owner-sub", enable: 1 });
  } });
  resources.push(() => userinfo.stop(true));
  const env = { storage, EDGE_EVER_VOS_MODE: "true", EDGE_EVER_VOS_USERINFO_URL: `http://127.0.0.1:${userinfo.port}/userinfo` };
  return { database, env, identity, note, create, mint: () => mintHybragNoteTicket(env, identity, "root", note.id),
    redeem: (ticket, proof = "owner-proof") => redeemHybragNoteTicket(env, ticket.token, proof) };
};

const backgroundFixture = async () => {
  const f=await fixture();
  f.env.EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY="test-deployment-encryption-key";
  const state={active:true,subject:"owner-sub",issues:0,revokes:0,controls:[],statusRequests:[],outage:false,onIssue:undefined};
  const secret="a".repeat(64);
  const platform=Bun.serve({port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path.endsWith("/userinfo")) return Response.json({sub:state.subject,enable:1});
    await request.json();
    if(path.endsWith("/issue")) {
      state.issues++;
      expect(request.headers.get("authorization")).toBe("Bearer owner-proof");
      await state.onIssue?.();
      return Response.json({protocol:1,secret,subject:state.subject});
    }
    expect(request.headers.get("authorization")).toBeNull();
    if(path.endsWith("/revoke")){state.revokes++;state.active=false;return Response.json({protocol:1,active:false});}
    return Response.json({protocol:1,active:state.active,...(state.active?{subject:state.subject}:{})});
  }});
  resources.push(()=>platform.stop(true));
  f.env.EDGE_EVER_VOS_USERINFO_URL=`http://127.0.0.1:${platform.port}/v1000/oauth2/userinfo`;
  const target=Bun.serve({port:0,async fetch(request){
    if(new URL(request.url).pathname.endsWith("/status")) {
      const input=await request.json();state.statusRequests.push(input);
      if(input.syncWorkspaceId)return Response.json({connected:true,syncRuns:[]});
      return Response.json({connected:true,backgroundAuthorization:1,backgroundSync:1});
    }
    if(state.outage) return new Response("offline",{status:503});
    expect(request.headers.get("authorization")).toBe(`Integration ${secret}`);
    const snapshot=await redeemHybragControl(f.env,(await request.json()).ticket,secret,"Integration");
    state.controls.push(snapshot);
    return Response.json({version:snapshot.version});
  }});
  resources.push(()=>target.stop(true));
  f.env.EDGE_EVER_HYBRAG_URL=`http://127.0.0.1:${target.port}`;
  const app=new Hono();
  app.onError((error,c)=>c.json({code:error.code??"failure"},error.status??500));
  registerHybragNoteRoutes(app);
  registerHybragSourceRoutes(app);
  const sourceRequest=(path,body,credential=secret)=>app.request(`/api/integrations/hybrag/${path}`,{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:`Integration ${credential}`},body:JSON.stringify(body),
  },f.env);
  const source=f.database.query("SELECT content_hash FROM memo_contents WHERE memo_id=?").get(f.note.id);
  const authorize=(rootId="root",configVersion=1,credential=secret)=>app.request("/api/integrations/hybrag/authorize",{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:`Integration ${credential}`},
    body:JSON.stringify({rootId,noteId:f.note.id,configVersion,sourceHash:source.content_hash,sourceTitle:"A title"}),
  },f.env);
  return {...f,state,secret,authorize,sourceRequest};
};

const snapshotSource = async(f,extra={})=>{
  const response=await f.sourceRequest("snapshot",{rootId:"root",configVersion:1,...extra});
  expect(response.status).toBe(200);
  return response.json();
};
const changesSource = async(f,snapshot,extra={})=>{
  const response=await f.sourceRequest("changes",{rootId:"root",configVersion:1,syncIdentity:snapshot.syncIdentity,graphRevision:snapshot.graphRevision,
    cursor:snapshot.snapshotCursor??snapshot.cursor,cursorStamp:snapshot.snapshotCursorStamp??snapshot.cursorStamp,...extra});
  expect(response.status).toBe(200);
  return response.json();
};

describe("single-note HybRAG source tickets", () => {
  test("paused roots retain authorization but deny live reads until a resumed version is acknowledged",async()=>{
    const f=await backgroundFixture();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    const before=await snapshotSource(f),ticket=await f.mint();
    f.database.exec("UPDATE hybrag_settings SET paused_roots_json='[\"root\"]',version=version+1");
    await expect(f.redeem(ticket)).rejects.toMatchObject({status:404});
    f.database.exec("UPDATE hybrag_delegations SET next_attempt_at=''");await maintainHybragDelegations(f.env);
    expect((await (await f.sourceRequest("plan",{rootId:"root",configVersion:2})).json()).paused).toBe(true);
    expect((await f.sourceRequest("snapshot",{rootId:"root",configVersion:2})).status).toBe(403);
    expect((await f.sourceRequest("changes",{rootId:"root",configVersion:2,syncIdentity:before.syncIdentity,graphRevision:before.graphRevision,cursor:before.snapshotCursor,cursorStamp:before.snapshotCursorStamp})).status).toBe(403);
    expect((await f.sourceRequest("export-note",{rootId:"root",configVersion:2,noteId:f.note.id})).status).toBe(403);
    expect(f.database.query("SELECT state FROM hybrag_delegations").get().state).toBe("active");
    expect(f.database.query("SELECT enabled,roots_json FROM hybrag_settings").get()).toEqual({enabled:1,roots_json:'["root"]'});
    f.database.exec("UPDATE hybrag_settings SET paused_roots_json='[]',version=version+1");
    expect((await f.sourceRequest("snapshot",{rootId:"root",configVersion:3})).status).toBe(403);
    f.database.exec("UPDATE hybrag_delegations SET next_attempt_at=''");await maintainHybragDelegations(f.env);
    const resumed=await f.sourceRequest("snapshot",{rootId:"root",configVersion:3});expect(resumed.status).toBe(200);
    expect((await resumed.json()).notes.some(n=>n.noteId===f.note.id)).toBe(true);
    expect(f.state.issues).toBe(1);
  });

  test("a pause at the final ticket-consumption boundary cannot export the note",async()=>{
    const f=await fixture(),ticket=await f.mint(),prepare=f.env.storage.db.prepare.bind(f.env.storage.db);
    let injected=false;
    f.env.storage.db.prepare=(sql)=>{
      if(!injected&&sql.includes("UPDATE hybrag_note_tickets SET consumed_at")){injected=true;f.database.exec("UPDATE hybrag_settings SET paused_roots_json='[\"root\"]'");}
      return prepare(sql);
    };
    await expect(f.redeem(ticket)).rejects.toMatchObject({status:409});
    expect(f.database.query("SELECT consumed_at FROM hybrag_note_tickets").get().consumed_at).toBeNull();
  });

  test("settings validate paused roots and older clients preserve pauses on retained roots",async()=>{
    const f=await fixture(),app=new Hono();
    app.onError((error,c)=>c.json({code:error.code},error.status??500));
    app.use("*",async(c,next)=>{c.set("auth",{kind:"user",actorId:f.identity.userId,workspaceId:f.identity.workspaceId,sessionId:"session"});await next();});
    registerHybragSettingsRoutes(app);
    const put=(version,roots,pausedRoots)=>app.request("/api/v1/integrations/hybrag/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:true,version,roots,...(pausedRoots?{pausedRoots}:{})})},f.env);
    expect((await put(1,["root"],["outside"])).status).toBe(400);
    expect((await put(1,["root"],["root","root"])).status).toBe(400);
    expect((await put(1,["root"],["root"])).status).toBe(200);
    expect((await (await app.request("/api/v1/integrations/hybrag/settings",{},f.env)).json()).pausedRoots).toEqual(["root"]);
    expect((await put(2,["root"])).status).toBe(200);
    expect(JSON.parse(f.database.query("SELECT paused_roots_json FROM hybrag_settings").get().paused_roots_json)).toEqual(["root"]);
    expect((await put(3,["outside"])).status).toBe(200);
    expect(JSON.parse(f.database.query("SELECT paused_roots_json FROM hybrag_settings").get().paused_roots_json)).toEqual([]);
  });

  test("background status uses fresh owner proof and server-selected workspace roots",async()=>{
    const f=await backgroundFixture(),app=new Hono();
    app.onError((error,c)=>c.json({code:error.code},error.status??500));
    app.use("*",async(c,next)=>{c.set("auth",{kind:"user",actorId:f.identity.userId,workspaceId:f.identity.workspaceId,sessionId:"session"});await next();});
    registerHybragManualRoutes(app);
    const call=()=>app.request("/api/v1/integrations/hybrag/background-status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accessToken:"owner-proof",syncWorkspaceId:"other",syncRoots:["outside"]})},f.env);
    expect((await call()).status).toBe(200);
    expect(f.state.statusRequests.at(-1)).toMatchObject({syncWorkspaceId:f.identity.workspaceId,syncRoots:["root"]});
    const before=f.state.statusRequests.length;
    f.state.subject="another-user";
    expect((await call()).status).toBe(403);
    expect(f.state.statusRequests.length).toBe(before);
  });

  test("source plans require the acknowledged version and preserve an explicitly saved schedule",async()=>{
    const f=await backgroundFixture();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    const plan=await f.sourceRequest("plan",{rootId:"root",configVersion:1});
    const initialPlan=await plan.json();
    expect(initialPlan.schedule).toMatchObject({mode:"interval",intervalMinutes:15});
    expect(initialPlan.rootName).toBe("Root");
    const app=new Hono();
    app.onError((error,c)=>c.json({code:error.code},error.status??500));
    app.use("*",async(c,next)=>{c.set("auth",{kind:"user",actorId:f.identity.userId,workspaceId:f.identity.workspaceId,sessionId:"session"});await next();});
    registerHybragSettingsRoutes(app);
    const schedule={mode:"night",intervalMinutes:30,timeZone:"Asia/Shanghai",nightStart:22,nightEnd:6};
    const put=(value,version=1)=>app.request("/api/v1/integrations/hybrag/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:true,roots:["root"],version,...(value?{schedule:value}:{})})},f.env);
    for(const invalid of [{...schedule,intervalMinutes:5},{...schedule,timeZone:"Invalid/Zone"},{...schedule,nightStart:6},{...schedule,mode:"unknown"}])expect((await put(invalid)).status).toBe(400);
    expect((await put(schedule)).status).toBe(200);
    expect((await f.sourceRequest("plan",{rootId:"root",configVersion:1})).status).toBe(403);
    expect((await f.sourceRequest("plan",{rootId:"root",configVersion:2})).status).toBe(403);
    f.database.exec("UPDATE hybrag_delegations SET next_attempt_at=''");
    await maintainHybragDelegations(f.env);
    expect((await (await f.sourceRequest("plan",{rootId:"root",configVersion:2})).json()).schedule).toEqual(schedule);
    expect((await put(undefined,2)).status).toBe(200);
    expect(JSON.parse(f.database.query("SELECT schedule_json FROM hybrag_settings").get().schedule_json)).toEqual(schedule);
    f.database.exec("UPDATE notebooks SET is_deleted=1 WHERE id='root'");
    expect((await f.sourceRequest("plan",{rootId:"root",configVersion:3})).status).toBe(403);
    await beginHybragDelegationRevocation(f.env,f.identity);
    expect((await f.sourceRequest("plan",{rootId:"root",configVersion:3})).status).toBe(403);
  });

  test("source snapshot pins its first cursor across pages and replays later edits without note bodies",async()=>{
    const f=await backgroundFixture();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    const outside=await f.create("outside private body","outside");
    await f.create("second note body");
    let page=await snapshotSource(f,{limit:1});
    const first=page,seen=new Set(page.notes.map(n=>n.noteId));
    expect(page.hasMore).toBe(true);
    expect(JSON.stringify(page)).not.toContain(outside.id);
    expect(JSON.stringify(page)).not.toContain("正文");
    const late=await f.create("late content");
    let pages=1;
    while(page.hasMore){
      page=await snapshotSource(f,{limit:1,afterNotebookId:page.afterNotebookId,afterNoteId:page.afterNoteId,
        startCursor:first.snapshotCursor,startCursorStamp:first.snapshotCursorStamp,syncIdentity:first.syncIdentity,graphRevision:first.graphRevision});
      for(const note of page.notes)seen.add(note.noteId);
      expect(page.snapshotCursor).toBe(first.snapshotCursor);
      expect(++pages).toBeLessThan(8);
    }
    expect(seen.has(f.note.id)).toBe(true);
    expect(seen.has(outside.id)).toBe(false);
    const delta=await changesSource(f,first);
    expect(delta.events.some(e=>e.noteId===late.id&&e.operation==="upsert")).toBe(true);
    expect(JSON.stringify(delta)).not.toContain("late content");
    const empty=await changesSource(f,delta);
    expect(empty.events).toEqual([]);
    expect(empty.cursor).toBe(delta.cursor);
  });

  test("source changes disclose tombstones but no new location or title for notes leaving the scope",async()=>{
    const f=await backgroundFixture();
    const removed=await f.create("deleted body"),outside=await f.create("unselected body","outside");
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    const first=await snapshotSource(f);
    f.database.query("UPDATE memos SET notebook_id='outside',title='moved private title' WHERE id=?").run(f.note.id);
    f.database.query("UPDATE memos SET is_deleted=1 WHERE id=?").run(removed.id);
    f.database.query("UPDATE memos SET title='unselected private title' WHERE id=?").run(outside.id);
    const delta=await changesSource(f,first);
    expect(delta.events.map(e=>[e.noteId,e.operation]).sort()).toEqual([[f.note.id,"delete"],[removed.id,"delete"]].sort());
    expect(delta.events.every(e=>Object.keys(e).sort().join(",")==="noteId,operation,sequence")).toBe(true);
    expect(JSON.stringify(delta)).not.toContain("private title");
    expect(JSON.stringify(delta)).not.toContain(outside.id);
    f.database.query("UPDATE memos SET notebook_id='child',title='now selected' WHERE id=?").run(outside.id);
    const entered=await changesSource(f,delta);
    expect(entered.events).toMatchObject([{noteId:outside.id,operation:"upsert",title:"now selected"}]);
    const rejected=await f.sourceRequest("export-note",{rootId:"root",configVersion:1,noteId:f.note.id});
    expect(rejected.status).toBe(404);
    const exported=await f.sourceRequest("export-note",{rootId:"root",configVersion:1,noteId:outside.id});
    expect(exported.status).toBe(200);
    expect((await exported.json()).markdown).toBe("unselected body");
  });

  test("source hierarchy changes request reconciliation and invalidate snapshot continuations",async()=>{
    const f=await backgroundFixture();
    const outside=await f.create("moving subtree","outside");
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    const first=await snapshotSource(f);
    f.database.query("UPDATE notebooks SET parent_id='root' WHERE id='outside'").run();
    const delta=await changesSource(f,first);
    expect(delta.rescan).toBe(true);
    expect(delta.graphRevision).toBeGreaterThan(first.graphRevision);
    const stale=await f.sourceRequest("snapshot",{rootId:"root",configVersion:1,syncIdentity:first.syncIdentity,graphRevision:first.graphRevision});
    expect(stale.status).toBe(409);
    const current=await snapshotSource(f);
    expect(current.notes.some(n=>n.noteId===outside.id)).toBe(true);
    await beginHybragDelegationRevocation(f.env,f.identity);
    expect((await f.sourceRequest("snapshot",{rootId:"root",configVersion:1})).status).toBe(403);
  });

  test("deleted selected roots expose only an empty metadata scope and can be restored",async()=>{
    for(const deletion of ["soft","hard","foreign"]){
      const f=await backgroundFixture();
      await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
      await maintainHybragDelegations(f.env);
      const first=await snapshotSource(f);
      expect(first.notes.some(note=>note.noteId===f.note.id)).toBe(true);
      if(deletion==="foreign"){
        const other=await provisionVosUser(f.env.storage.db,{subject:"other-root-owner",username:"other-root-owner",displayName:"Other",role:"owner"});
        const space=f.database.query("SELECT workspace_id FROM workspace_members WHERE user_id=?").get(other.user.id).workspace_id;
        f.database.query("UPDATE notebooks SET workspace_id=?,name='private foreign title' WHERE id='root'").run(space);
      } else {
        f.database.exec(deletion==="soft"?"UPDATE notebooks SET is_deleted=1 WHERE id='root'":"UPDATE notebooks SET parent_id=NULL WHERE parent_id='root'; DELETE FROM notebooks WHERE id='root'");
      }
      const plan=await f.sourceRequest("plan",{rootId:"root",configVersion:1});
      expect(plan.status).toBe(200);
      const value=await plan.json();
      expect(value.rootMissing).toBe(true);
      expect(value.rootName).toBeUndefined();
      expect(JSON.stringify(value)).not.toContain("private foreign title");
      const delta=await changesSource(f,first);
      expect(delta.rescan).toBe(true);
      const empty=await snapshotSource(f);
      expect(empty.notes).toEqual([]);
      expect(empty.hasMore).toBe(false);
      expect(empty.rootName).toBe("");
      expect(JSON.stringify(empty)).not.toContain(f.note.id);
      expect(JSON.stringify(empty)).not.toContain("正文");
      expect((await f.sourceRequest("export-note",{rootId:"root",configVersion:1,noteId:f.note.id})).status).toBe(403);
      expect((await f.sourceRequest("snapshot",{rootId:"unselected",configVersion:1})).status).toBe(403);
      if(deletion==="soft"){
        f.database.exec("UPDATE notebooks SET is_deleted=0 WHERE id='root'");
        expect((await (await f.sourceRequest("plan",{rootId:"root",configVersion:1})).json()).rootMissing).toBe(false);
        expect((await snapshotSource(f)).notes.some(note=>note.noteId===f.note.id)).toBe(true);
      }
    }
  });

  test("a stale deleted-root snapshot cannot erase a concurrently restored scope",async()=>{
    const f=await backgroundFixture();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    await snapshotSource(f);
    f.database.exec("UPDATE notebooks SET is_deleted=1 WHERE id='root'");
    const batch=f.env.storage.db.batch.bind(f.env.storage.db);
    let intercepted=false;
    f.env.storage.db.batch=async(statements)=>{
      if(!intercepted){
        intercepted=true;
        f.database.exec("UPDATE notebooks SET is_deleted=0 WHERE id='root'");
        expect((await snapshotSource(f)).notes.some(note=>note.noteId===f.note.id)).toBe(true);
      }
      return batch(statements);
    };
    expect((await f.sourceRequest("snapshot",{rootId:"root",configVersion:1})).status).toBe(409);
    expect((await snapshotSource(f)).notes.some(note=>note.noteId===f.note.id)).toBe(true);
  });

  test("a stale hierarchy build cannot delete a newer cached notebook scope",async()=>{
    const f=await backgroundFixture();
    const moved=await f.create("moved subtree body","outside");
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    const batch=f.env.storage.db.batch.bind(f.env.storage.db);
    let intercepted=false;
    f.env.storage.db.batch=async(statements)=>{
      if(!intercepted){
        intercepted=true;
        f.database.query("UPDATE notebooks SET parent_id='root' WHERE id='outside'").run();
        const newer=await snapshotSource(f);
        expect(newer.notes.some(n=>n.noteId===moved.id)).toBe(true);
      }
      return batch(statements);
    };
    const stale=await f.sourceRequest("snapshot",{rootId:"root",configVersion:1});
    expect(stale.status).toBe(409);
    expect((await snapshotSource(f)).notes.some(n=>n.noteId===moved.id)).toBe(true);
  });

  test("source rejects changed receipts and can recover after the entire changelog was pruned",async()=>{
    const f=await backgroundFixture();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    const first=await snapshotSource(f);
    const bad=await f.sourceRequest("changes",{rootId:"root",configVersion:1,syncIdentity:first.syncIdentity,graphRevision:first.graphRevision,
      cursor:first.snapshotCursor,cursorStamp:"b".repeat(64)});
    expect(bad.status).toBe(409);
    f.database.query("DELETE FROM mobile_sync_changes WHERE workspace_id=?").run(f.identity.workspaceId);
    const stale=await f.sourceRequest("changes",{rootId:"root",configVersion:1,syncIdentity:first.syncIdentity,graphRevision:first.graphRevision,
      cursor:first.snapshotCursor,cursorStamp:first.snapshotCursorStamp});
    expect(stale.status).toBe(409);
    const recovered=await snapshotSource(f);
    const empty=await changesSource(f,recovered);
    expect(empty.events).toEqual([]);
    f.database.query("UPDATE workspaces SET created_at='new-source-identity' WHERE id=?").run(f.identity.workspaceId);
    expect((await f.sourceRequest("changes",{rootId:"root",configVersion:1,syncIdentity:recovered.syncIdentity,graphRevision:recovered.graphRevision,
      cursor:recovered.snapshotCursor,cursorStamp:recovered.snapshotCursorStamp})).status).toBe(409);
  });

  test("source pagination reuses scope and index bookmarks on a representative workspace",async()=>{
    const f=await backgroundFixture();
    const insertBook=f.database.query("INSERT INTO notebooks(id,workspace_id,parent_id,name) VALUES (?,?,?,?)");
    const insertNote=f.database.query("INSERT INTO memos(id,workspace_id,notebook_id,title) VALUES (?,?,?,?)");
    const insertContent=f.database.query("INSERT INTO memo_contents(memo_id,content_hash,content_json) VALUES (?,?,'{}')");
    f.database.transaction(()=>{
      for(let book=0;book<100;book++){
        const id=`book_${String(book).padStart(3,"0")}`;
        insertBook.run(id,f.identity.workspaceId,"root",id);
        for(let i=0;i<20;i++){
          const note=`selected_${book}_${i}`;
          insertNote.run(note,f.identity.workspaceId,id,note);
          insertContent.run(note,"b".repeat(64));
        }
      }
      for(let i=0;i<5000;i++)insertNote.run(`unselected_${i}`,f.identity.workspaceId,"outside","not selected");
    })();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    const prepare=f.env.storage.db.prepare.bind(f.env.storage.db),sql=[];
    let snapshotQuery,snapshotArgs;
    f.env.storage.db.prepare=(query)=>{
      sql.push(query);
      const statement=prepare(query);
      if(query.includes("CROSS JOIN memos m INDEXED BY hybrag_snapshot_note_cursor"))return {
        bind(...args){snapshotQuery=query;snapshotArgs=args;return statement.bind(...args);},
      };
      return statement;
    };
    let page=await snapshotSource(f),first=page,total=page.notes.length,pages=1;
    while(page.hasMore){
      page=await snapshotSource(f,{afterNotebookId:page.afterNotebookId,afterNoteId:page.afterNoteId,
        startCursor:first.snapshotCursor,startCursorStamp:first.snapshotCursorStamp,syncIdentity:first.syncIdentity,graphRevision:first.graphRevision});
      total+=page.notes.length;
      expect(++pages).toBeLessThan(50);
    }
    expect(total).toBe(2001);
    expect(sql.filter(q=>q.includes("WITH RECURSIVE selected")).length).toBe(2);
    expect(sql.some(q=>q.includes("content_markdown")||q.includes("content_json"))).toBe(false);
    const plan=f.database.query("EXPLAIN QUERY PLAN "+snapshotQuery).all(...snapshotArgs).map(r=>r.detail).join("\n");
    expect(plan).toContain("hybrag_snapshot_note_cursor");
    expect(plan).not.toContain("USE TEMP B-TREE");
  },20000);
  test("delegation API requires explicit consent and a fresh proof for the local owner, and never returns the credential",async()=>{
    const f=await backgroundFixture();
    const app=new Hono(),tasks=[];
    app.onError((error,c)=>c.json({code:error.code},error.status??500));
    app.use("*",async(c,next)=>{
      c.set("auth",{kind:"user",actorType:"user",actorId:f.identity.userId,workspaceId:f.identity.workspaceId,role:"owner",sessionId:"session",scopes:[]});
      await next();
    });
    registerHybragDelegationRoutes(app);
    const issue=(consent)=>app.fetch(new Request("http://vnote/api/v1/integrations/hybrag/delegation",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({consent,accessToken:"owner-proof",version:1}),
    }),f.env,{waitUntil(p){tasks.push(p);},passThroughOnException(){}});
    expect((await issue(false)).status).toBe(400);
    f.state.subject="someone-else";
    expect((await issue(true)).status).toBe(403);
    expect(f.state.issues).toBe(0);
    f.state.subject="owner-sub";
    const response=await issue(true);
    expect(response.status).toBe(200);
    const body=await response.text();
    expect(body).not.toContain(f.secret);
    expect(body).not.toContain("owner-proof");
    await Promise.all(tasks);
    expect(f.state.issues).toBe(1);
  });
  test("background consent registers the exact encrypted grant and delivers control without a human token",async()=>{
    const f=await backgroundFixture();
    expect(await enableHybragDelegation(f.env,f.identity,"owner-proof",1)).toEqual({state:"active"});
    const stored=f.database.query("SELECT * FROM hybrag_delegations").get();
    expect(stored.secret_encrypted).not.toContain(f.secret);
    expect(stored.secret_hash).not.toBe(f.secret);
    await maintainHybragDelegations(f.env);
    expect(f.state.controls).toHaveLength(1);
    expect(f.state.controls[0]).toMatchObject({subject:"owner-sub",enabled:true,roots:["root"],version:1});
    expect(f.database.query("SELECT target_ready FROM hybrag_delegations").get().target_ready).toBe(1);
    expect((await f.authorize()).status).toBe(200);
    expect((await f.authorize("outside")).status).toBe(403);
    expect((await f.authorize("root",2)).status).toBe(409);
    expect((await f.authorize("root",1,"b".repeat(64))).status).toBe(403);
    const ticket=await f.mint();
    expect((await redeemHybragNoteTicket(f.env,ticket.token,f.secret,"Integration")).noteId).toBe(f.note.id);
    f.database.query("UPDATE memo_contents SET content_hash=? WHERE memo_id=?").run("b".repeat(64),f.note.id);
    expect((await f.authorize()).status).toBe(403,"an indexed attempt cannot publish after its source content changes");
  });

  test("revocation survives target outage and delivers a deny-only snapshot after platform revocation",async()=>{
    const f=await backgroundFixture();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    const ticket=await f.mint();
    await beginHybragDelegationRevocation(f.env,f.identity);
    expect(f.database.query("SELECT enabled FROM hybrag_settings").get().enabled).toBe(0);
    expect((await f.authorize()).status).toBe(403);
    await expect(redeemHybragNoteTicket(f.env,ticket.token,f.secret,"Integration")).rejects.toThrow();
    f.state.outage=true;
    await maintainHybragDelegations(f.env);
    expect(f.state.active).toBe(false);
    expect(f.database.query("SELECT state,secret_encrypted FROM hybrag_delegations").get().state).toBe("revoking");
    f.state.outage=false;
    f.database.query("UPDATE hybrag_delegations SET next_attempt_at=''").run();
    await maintainHybragDelegations(f.env);
    expect(f.state.controls.at(-1)).toMatchObject({enabled:false,version:2});
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_delegations").get().n).toBe(0);
  });

  test("concurrent consent issues once and an interrupted settings change leaves a durable revoke outbox",async()=>{
    const f=await backgroundFixture();
    let beginIssue,finishIssue;
    const started=new Promise(resolve=>{beginIssue=resolve;});
    const blocked=new Promise(resolve=>{finishIssue=resolve;});
    f.state.onIssue=async()=>{beginIssue();await blocked;};
    const first=enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await started;
    await expect(enableHybragDelegation(f.env,f.identity,"owner-proof",1)).rejects.toThrow();
    f.database.query("UPDATE hybrag_settings SET enabled=0,version=version+1").run();
    finishIssue();
    await expect(first).rejects.toThrow();
    expect(f.state.issues).toBe(1);
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_delegations").get().n).toBe(0);
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_grant_revocations").get().n).toBe(1);
    f.database.query("UPDATE hybrag_grant_revocations SET next_attempt_at=''").run();
    await maintainHybragDelegations(f.env);
    expect(f.state.revokes).toBe(1);
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_grant_revocations").get().n).toBe(0);
  });

  test("deleted settings retain a deliverable revocation tombstone",async()=>{
    const f=await backgroundFixture();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    await maintainHybragDelegations(f.env);
    f.database.query("DELETE FROM hybrag_settings").run();
    await beginHybragDelegationRevocation(f.env,f.identity);
    await maintainHybragDelegations(f.env);
    expect(f.state.controls.at(-1)).toMatchObject({enabled:false,version:2});
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_delegations").get().n).toBe(0);
  });

  test("personal integration rejects membership downgrade, shared personal spaces and a changed source title",async()=>{
    for(const change of ["member","shared","title"]){
      const f=await backgroundFixture();
      await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
      await maintainHybragDelegations(f.env);
      expect((await f.authorize()).status).toBe(200);
      if(change==="member") f.database.query("UPDATE workspace_members SET role='member' WHERE user_id=?").run(f.identity.userId);
      if(change==="title") f.database.query("UPDATE memos SET title='Renamed' WHERE id=?").run(f.note.id);
      if(change==="shared"){
        const peer=await provisionVosUser(f.env.storage.db,{subject:"peer",username:"peer",displayName:"Peer",role:"member"});
        f.database.query("DELETE FROM workspace_members WHERE user_id=?").run(peer.user.id);
        f.database.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'member')").run(f.identity.workspaceId,peer.user.id);
      }
      expect((await f.authorize()).status).toBe(403);
    }
  });
  test("local lifecycle changes cannot revive a delegation after authority is restored", async () => {
    const transitions = [
      ["UPDATE users SET is_disabled=1", "UPDATE users SET is_disabled=0"],
      ["UPDATE user_identities SET subject='replacement' WHERE provider='vos'", "UPDATE user_identities SET subject='owner-sub' WHERE provider='vos'"],
      ["DELETE FROM user_identities WHERE provider='vos'", "INSERT INTO user_identities(provider,subject,user_id) SELECT 'vos','owner-sub',id FROM users WHERE username='owner'"],
      ["UPDATE workspace_members SET role='member'", "UPDATE workspace_members SET role='owner'"],
      ["DELETE FROM workspace_members", "INSERT INTO workspace_members(workspace_id,user_id,role) SELECT w.id,u.id,'owner' FROM workspaces w,users u WHERE w.id<>'ws_default' AND u.username='owner'"],
      ["UPDATE workspaces SET is_personal=0", "UPDATE workspaces SET is_personal=1"],
    ];
    for (const [remove,restore] of transitions) {
      const f=await backgroundFixture();
      await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
      await maintainHybragDelegations(f.env);
      f.database.exec(remove);
      f.database.exec(restore);
      expect(f.database.query("SELECT state,version FROM hybrag_delegations").get()).toEqual({state:"revoking",version:2});
      expect(f.database.query("SELECT enabled,version FROM hybrag_settings").get()).toEqual({enabled:0,version:2});
      expect((await f.authorize()).status).toBe(403);
      expect((await f.sourceRequest("snapshot",{rootId:"root",configVersion:1})).status).toBe(403);
      await maintainHybragDelegations(f.env);
      expect(f.state.controls.at(-1)).toMatchObject({enabled:false,version:2});
    }
  });

  test("temporary sharing retires only the affected owner's delegation",async()=>{
    const f=await backgroundFixture();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    const peer=await provisionVosUser(f.env.storage.db,{subject:"peer",username:"peer",displayName:"Peer",role:"member"});
    f.database.query("DELETE FROM workspace_members WHERE user_id=?").run(peer.user.id);
    f.database.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES (?,?,'member')").run(f.identity.workspaceId,peer.user.id);
    f.database.query("DELETE FROM workspace_members WHERE user_id=?").run(peer.user.id);
    expect(f.database.query("SELECT state FROM hybrag_delegations").get().state).toBe("revoking");
    expect(await readVerifiedHybragDelegation(f.env,f.identity)).toBeNull();
  });

  test("authority changing and returning during issuance cannot publish a late credential",async()=>{
    const f=await backgroundFixture();
    f.state.onIssue=()=>{
      f.database.query("UPDATE users SET is_disabled=1 WHERE id=?").run(f.identity.userId);
      f.database.query("UPDATE users SET is_disabled=0 WHERE id=?").run(f.identity.userId);
    };
    await expect(enableHybragDelegation(f.env,f.identity,"owner-proof",1)).rejects.toMatchObject({status:409});
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_delegations").get().n).toBe(0);
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_grant_revocations").get().n).toBe(1);
  });

  test("ordinary profile and content edits preserve the delegation",async()=>{
    const f=await backgroundFixture();
    await enableHybragDelegation(f.env,f.identity,"owner-proof",1);
    f.database.exec("UPDATE users SET display_name='New name'; UPDATE notebooks SET name='Renamed'");
    f.database.query("UPDATE memos SET title='Edited' WHERE id=?").run(f.note.id);
    expect((await readVerifiedHybragDelegation(f.env,f.identity))?.secret).toBe(f.secret);
    expect(f.database.query("SELECT enabled,version FROM hybrag_settings").get()).toEqual({enabled:1,version:1});
  });

  test("verified delegation rejects another subject and local revocation during status check", async () => {
    const f = await fixture();
    f.env.EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY = "deployment-key";
    await saveHybragDelegation(f.env, f.identity, "a".repeat(64));
    let subject = "other-sub", revokeDuringCheck = false;
    const platform = Bun.serve({ port: 0, async fetch() {
      if (revokeDuringCheck) await beginHybragDelegationRevocation(f.env, f.identity);
      return Response.json({ protocol: 1, active: true, subject });
    } });
    resources.push(() => platform.stop(true));
    f.env.EDGE_EVER_VOS_USERINFO_URL = `http://127.0.0.1:${platform.port}/v1000/oauth2/userinfo`;
    expect(await readVerifiedHybragDelegation(f.env, f.identity)).toBeNull();
    subject = f.identity.subject;
    expect((await readVerifiedHybragDelegation(f.env, f.identity)).secret).toBe("a".repeat(64));
    revokeDuringCheck = true;
    expect(await readVerifiedHybragDelegation(f.env, f.identity)).toBeNull();
    expect(f.database.query("SELECT state FROM hybrag_delegations").get().state).toBe("revoking");
    f.database.query("UPDATE users SET is_disabled = 1 WHERE id = ?").run(f.identity.userId);
    expect(await readVerifiedHybragDelegation(f.env, f.identity)).toBeNull();
    f.database.query("UPDATE users SET is_disabled = 0 WHERE id = ?").run(f.identity.userId);
    expect(await readVerifiedHybragDelegation(f.env, f.identity)).toBeNull();
  });
  test("delegation revocation persists and stale completion cannot delete a replacement", async () => {
    const f = await fixture();
    f.env.EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY = "deployment-key";
    const secret = "a".repeat(64);
    await saveHybragDelegation(f.env, f.identity, secret);
    const stored = f.database.query("SELECT secret_encrypted FROM hybrag_delegations").get();
    expect(stored.secret_encrypted).not.toContain(secret);
    expect((await readHybragDelegation(f.env, f.identity, "active")).secret).toBe(secret);
    await expect(saveHybragDelegation(f.env, f.identity, secret)).rejects.toThrow();
    const old = await beginHybragDelegationRevocation(f.env, f.identity);
    expect(await readHybragDelegation(f.env, f.identity, "active")).toBeNull();
    expect((await readHybragDelegation(f.env, f.identity, "revoking")).secret).toBe(secret);
    expect(await finishHybragDelegationRevocation(f.env, f.identity, old.id, old.version)).not.toBeNull();
    await saveHybragDelegation(f.env, f.identity, "b".repeat(64));
    const replacement = await beginHybragDelegationRevocation(f.env, f.identity);
    expect(replacement.id).not.toBe(old.id);
    expect(await finishHybragDelegationRevocation(f.env, f.identity, old.id, old.version)).toBeNull();
    expect((await readHybragDelegation(f.env, f.identity, "revoking")).secret).toBe("b".repeat(64));
  });
  test("control delivery retries after outage and redeems only the current owner's snapshot", async () => {
    const f = await fixture();
    f.database.exec("DELETE FROM hybrag_control_delivery");
    f.env.EDGE_EVER_HYBRAG_URL = "http://127.0.0.1:1";
    expect(await deliverHybragControl(f.env, f.identity, "owner-proof")).toMatchObject({ pending: true, version: 1 });
    expect(f.database.query("SELECT * FROM hybrag_control_delivery").get()).toBeNull();
    let redeemed;
    const target = Bun.serve({ port: 0, async fetch(request) {
      const { ticket } = await request.json();
      await expect(redeemHybragControl(f.env, ticket, "other-proof")).rejects.toMatchObject({ status: 409 });
      redeemed = await redeemHybragControl(f.env, ticket, "owner-proof");
      await expect(redeemHybragControl(f.env, ticket, "owner-proof")).rejects.toMatchObject({ status: 409 });
      return Response.json({ version: redeemed.version });
    } });
    resources.push(() => target.stop(true));
    f.env.EDGE_EVER_HYBRAG_URL = `http://127.0.0.1:${target.port}`;
    expect(await deliverHybragControl(f.env, f.identity, "owner-proof")).toMatchObject({ pending: false, version: 1 });
    expect(redeemed).toMatchObject({ subject: "owner-sub", workspaceId: f.identity.workspaceId, version: 1, enabled: true, roots: ["root"] });
    expect(f.database.query("SELECT acknowledged_version FROM hybrag_control_delivery").get()).toEqual({ acknowledged_version: 1 });
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_control_tickets").get().n).toBe(0);
  });
  test("control ticket becomes stale if settings change during delivery", async () => {
    const f = await fixture();
    f.database.exec("DELETE FROM hybrag_control_delivery");
    const target = Bun.serve({ port: 0, async fetch(request) {
      const { ticket } = await request.json();
      f.database.query("UPDATE hybrag_settings SET enabled = 0, version = version + 1 WHERE user_id = ?").run(f.identity.userId);
      await expect(redeemHybragControl(f.env, ticket, "owner-proof")).rejects.toMatchObject({ status: 409 });
      return new Response(null, { status: 409 });
    } });
    resources.push(() => target.stop(true));
    f.env.EDGE_EVER_HYBRAG_URL = `http://127.0.0.1:${target.port}`;
    expect(await deliverHybragControl(f.env, f.identity, "owner-proof")).toMatchObject({ pending: true });
    expect(f.database.query("SELECT * FROM hybrag_control_delivery").get()).toBeNull();
  });
  test("a target response cannot acknowledge an unredeemed control ticket", async () => {
    const f = await fixture();
    f.database.exec("DELETE FROM hybrag_control_delivery");
    const target = Bun.serve({ port: 0, fetch: () => Response.json({ version: 1 }) });
    resources.push(() => target.stop(true));
    f.env.EDGE_EVER_HYBRAG_URL = `http://127.0.0.1:${target.port}`;
    expect(await deliverHybragControl(f.env, f.identity, "owner-proof")).toMatchObject({ pending: true });
    expect(f.database.query("SELECT * FROM hybrag_control_delivery").get()).toBeNull();
  });
  test("note export fails closed until the current control version is acknowledged", async () => {
    const f = await fixture();
    const ticket = await f.mint();
    f.database.exec("DELETE FROM hybrag_control_delivery");
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    await expect(f.redeem(ticket)).rejects.toMatchObject({ status: 404 });
  });
  test("control migration retains an existing enabled configuration", () => {
    const database = new Database(":memory:");
    resources.push(() => database.close());
    database.exec(`CREATE TABLE hybrag_settings (user_id TEXT, workspace_id TEXT, version INTEGER, enabled INTEGER, roots_json TEXT,
      PRIMARY KEY (user_id, workspace_id));
      INSERT INTO hybrag_settings VALUES ('u', 'w', 7, 1, '["root"]');`);
    database.exec(readFileSync("migrations/0099_hybrag_control_events.sql", "utf8"));
    expect(database.query("SELECT user_id, workspace_id, version, enabled, roots_json FROM hybrag_control_events").get())
      .toEqual({ user_id: "u", workspace_id: "w", version: 7, enabled: 1, roots_json: '["root"]' });
  });
  test("settings versions create durable control snapshots atomically", async () => {
    const f = await fixture();
    const events = () => f.database.query("SELECT version, enabled, roots_json FROM hybrag_control_events WHERE user_id = ? ORDER BY version").all(f.identity.userId);
    expect(events()).toEqual([{ version: 1, enabled: 1, roots_json: '["root"]' }]);
    f.database.query("UPDATE hybrag_settings SET enabled = 0, version = version + 1 WHERE user_id = ? AND version = ?").run(f.identity.userId, 1);
    f.database.query("UPDATE hybrag_settings SET enabled = 1, version = version + 1 WHERE user_id = ? AND version = ?").run(f.identity.userId, 1);
    expect(events()).toEqual([
      { version: 1, enabled: 1, roots_json: '["root"]' },
      { version: 2, enabled: 0, roots_json: '["root"]' },
    ]);
    expect(() => f.database.transaction(() => {
      f.database.query("UPDATE hybrag_settings SET version = version + 1 WHERE user_id = ?").run(f.identity.userId);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(events()).toHaveLength(2);
  });
  test("manual root run persists indexing progress and stops after authorization changes", async () => {
    const f = await fixture();
    let indexed = false;
    let imports = 0;
    const target = Bun.serve({ port: 0, async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/control")) {
        const { ticket } = await request.json();
        return Response.json({ version: (await redeemHybragControl(f.env, ticket, "owner-proof")).version });
      }
      if (new URL(request.url).pathname.endsWith("/status")) {
        const input = await request.json();
        return Response.json(input.rootId ? { connected: true, result: { state: indexed ? "completed" : "processing", attempt: "attempt-1" } } : { connected: true });
      }
      imports++;
      expect(f.database.query("SELECT pending_note_id, last_error FROM hybrag_manual_runs").get())
        .toEqual({ pending_note_id: f.note.id, last_error: "hybrag_delivery_uncertain" });
      const { ticket } = await request.json();
      await redeemHybragNoteTicket(f.env, ticket, "owner-proof");
      return Response.json({ accepted: true, knowledgeBaseId: "kb", knowledgeId: "doc", state: "pending", attempt: "attempt-1" }, { status: 202 });
    } });
    resources.push(() => target.stop(true));
    f.env.EDGE_EVER_HYBRAG_URL = `http://127.0.0.1:${target.port}`;
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("auth", { kind: "user", actorId: f.identity.userId, workspaceId: f.identity.workspaceId, sessionId: "session" }); await next(); });
    app.onError((error, c) => c.json({ error: { code: error.code } }, error.status || 500));
    registerHybragManualRoutes(app);
    const post = (route) => app.request(`/api/v1/integrations/hybrag/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rootId: "root", accessToken: "owner-proof" }) }, f.env);
    expect((await post("start")).status).toBe(200);
    expect((await post("step")).status).toBe(200);
    expect(imports).toBe(1);
    let run = f.database.query("SELECT * FROM hybrag_manual_runs").get();
    expect(run).toMatchObject({ pending_note_id: f.note.id, completed: 0, state: "running" });
    expect(await (await post("start")).json()).toMatchObject({ resumed: true });
    expect(f.database.query("SELECT pending_note_id FROM hybrag_manual_runs").get().pending_note_id).toBe(f.note.id);
    await post("step");
    expect(f.database.query("SELECT completed FROM hybrag_manual_runs").get().completed).toBe(0);
    indexed = true;
    await post("step");
    await post("step");
    run = f.database.query("SELECT * FROM hybrag_manual_runs").get();
    expect(run).toMatchObject({ completed: 1, state: "completed", pending_note_id: "" });
    const other = await provisionVosUser(f.env.storage.db, { subject: "other-sub", username: "other", displayName: "Other", role: "owner" });
    const otherWorkspace = f.database.query("SELECT workspace_id FROM workspace_members WHERE user_id = ?").get(other.user.id).workspace_id;
    const otherApp = new Hono();
    otherApp.use("*", async (c, next) => { c.set("auth", { kind: "user", actorId: other.user.id, workspaceId: otherWorkspace, sessionId: "other-session" }); await next(); });
    registerHybragManualRoutes(otherApp);
    expect((await (await otherApp.request("/api/v1/integrations/hybrag/runs", {}, f.env)).json()).runs).toEqual([]);
    await post("start");
    f.database.exec("UPDATE hybrag_settings SET enabled = 0, version = version + 1");
    expect((await post("step")).status).toBe(403);
    expect(imports).toBe(1);
    f.database.exec("UPDATE users SET is_disabled = 1");
    expect((await app.request("/api/v1/integrations/hybrag/runs", {}, f.env)).status).toBe(403);
  });

  for (const refusal of ["definite", "legacy", "missing-flag", "wrong-code"]) test(`manual retry distinguishes ${refusal} model refusal`, async () => {
    const f = await fixture();
    let imports = 0;
    const target = Bun.serve({ port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/control")) {
        const { ticket } = await request.json();
        return Response.json({ version: (await redeemHybragControl(f.env, ticket, "owner-proof")).version });
      }
      if (path.endsWith("/status")) return Response.json({ connected: true });
      imports++;
      const { ticket } = await request.json();
      await redeemHybragNoteTicket(f.env, ticket, "owner-proof");
      if (imports === 1) return Response.json(
        refusal === "definite" ? { code: "vnote_embedding_unavailable", accepted: false } :
        refusal === "missing-flag" ? { code: "vnote_embedding_unavailable" } :
        refusal === "wrong-code" ? { code: "unknown", accepted: false } : { error: "model or storage" }, { status: 422 });
      return Response.json({ accepted: true, knowledgeBaseId: "kb", knowledgeId: "doc", state: "pending", attempt: "retry-attempt" }, { status: 202 });
    } });
    resources.push(() => target.stop(true));
    f.env.EDGE_EVER_HYBRAG_URL = `http://127.0.0.1:${target.port}`;
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("auth", { kind: "user", actorId: f.identity.userId, workspaceId: f.identity.workspaceId, sessionId: "session" }); await next(); });
    app.onError((error, c) => c.json({ error: { code: error.code } }, error.status || 500));
    registerHybragManualRoutes(app);
    const post = (route) => app.request(`/api/v1/integrations/hybrag/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rootId: "root", accessToken: "owner-proof" }) }, f.env);
    expect((await post("start")).status).toBe(200);
    expect((await post("step")).status).toBe(422);
    const run = f.database.query("SELECT pending_note_id, last_error, completed FROM hybrag_manual_runs").get();
    if (refusal === "definite") {
      expect(run).toEqual({ pending_note_id: "", last_error: "hybrag_embedding_unavailable", completed: 0 });
      expect((await post("step")).status).toBe(200);
      expect(imports).toBe(2);
      expect(f.database.query("SELECT pending_attempt FROM hybrag_manual_runs").get().pending_attempt).toBe("retry-attempt");
    } else {
      expect(run).toEqual({ pending_note_id: f.note.id, last_error: "hybrag_delivery_uncertain", completed: 0 });
      expect(await (await post("step")).json()).toEqual({ state: "recovery_required" });
      expect(imports).toBe(1);
    }
  });

  test("an ambiguous delivery does not accept an older completed generation", async () => {
    const f = await fixture();
    let imports = 0, noteStatuses = 0;
    const target = Bun.serve({ port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/control")) {
        const { ticket } = await request.json();
        return Response.json({ version: (await redeemHybragControl(f.env, ticket, "owner-proof")).version });
      }
      if (path.endsWith("/status")) {
        const input = await request.json();
        if (input.rootId) noteStatuses++;
        return Response.json(input.rootId ? { connected: true, result: { state: "completed" } } : { connected: true });
      }
      imports++;
      const { ticket } = await request.json();
      await redeemHybragNoteTicket(f.env, ticket, "owner-proof");
      return new Response(null, { status: 500 });
    } });
    resources.push(() => target.stop(true));
    f.env.EDGE_EVER_HYBRAG_URL = `http://127.0.0.1:${target.port}`;
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("auth", { kind: "user", actorId: f.identity.userId, workspaceId: f.identity.workspaceId, sessionId: "session" }); await next(); });
    app.onError((error, c) => c.json({ error: { code: error.code } }, error.status || 500));
    registerHybragManualRoutes(app);
    const post = (route) => app.request(`/api/v1/integrations/hybrag/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rootId: "root", accessToken: "owner-proof" }) }, f.env);
    expect((await post("start")).status).toBe(200);
    expect((await post("step")).status).toBe(502);
    expect(f.database.query("SELECT pending_note_id, last_error, completed FROM hybrag_manual_runs").get())
      .toEqual({ pending_note_id: f.note.id, last_error: "hybrag_delivery_uncertain", completed: 0 });
    expect(await (await post("step")).json()).toEqual({ state: "recovery_required" });
    expect(imports).toBe(1);
    expect(noteStatuses).toBe(0);
  });

  test("a reserved delivery remains uncertain after an abandoned lock", async () => {
    const f = await fixture();
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("auth", { kind: "user", actorId: f.identity.userId, workspaceId: f.identity.workspaceId, sessionId: "session" }); await next(); });
    app.onError((error, c) => c.json({ error: { code: error.code } }, error.status || 500));
    registerHybragManualRoutes(app);
    f.database.query(`INSERT INTO hybrag_manual_runs
      (user_id, workspace_id, root_id, config_version, pending_note_id, last_error, updated_at, lock_token, lock_until)
      VALUES (?, ?, 'root', 1, ?, 'hybrag_delivery_uncertain', ?, 'abandoned', ?)`)
      .run(f.identity.userId, f.identity.workspaceId, f.note.id, new Date().toISOString(), "2000-01-01T00:00:00.000Z");
    const response = await app.request("/api/v1/integrations/hybrag/step", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootId: "root", accessToken: "owner-proof" }),
    }, f.env);
    expect(await response.json()).toEqual({ state: "recovery_required" });
    expect(f.database.query("SELECT pending_note_id, last_error, completed FROM hybrag_manual_runs").get())
      .toEqual({ pending_note_id: f.note.id, last_error: "hybrag_delivery_uncertain", completed: 0 });
  });

  test("manual root run records unsupported content as skipped without exporting it", async () => {
    const f = await fixture();
    f.database.exec("UPDATE memos SET is_deleted = 1");
    await f.create("![image](https://example.test/image.png)");
    let imports = 0;
    const target = Bun.serve({ port: 0, async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/control")) {
        const { ticket } = await request.json();
        return Response.json({ version: (await redeemHybragControl(f.env, ticket, "owner-proof")).version });
      }
      if (new URL(request.url).pathname.endsWith("/status")) return Response.json({ connected: true });
      imports++;
      return new Response(null, { status: 500 });
    } });
    resources.push(() => target.stop(true));
    f.env.EDGE_EVER_HYBRAG_URL = `http://127.0.0.1:${target.port}`;
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("auth", { kind: "user", actorId: f.identity.userId, workspaceId: f.identity.workspaceId, sessionId: "session" }); await next(); });
    app.onError((error, c) => c.json({ error: { code: error.code } }, error.status || 500));
    registerHybragManualRoutes(app);
    const post = (route) => app.request(`/api/v1/integrations/hybrag/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rootId: "root", accessToken: "owner-proof" }) }, f.env);
    await post("start");
    await post("step");
    await post("step");
    expect(f.database.query("SELECT skipped, skipped_resource, state FROM hybrag_manual_runs").get()).toEqual({ skipped: 1, skipped_resource: 1, state: "completed" });
    expect(imports).toBe(0);
  });
  test.each(["recovery_required", "not_imported", "completed"])("manual run stops on unsafe target status %s", async (targetState) => {
    const f = await fixture();
    const target = Bun.serve({ port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/status")) {
        const input = await request.json();
        return Response.json(input.rootId ? { connected: true, result: { state: targetState, attempt: targetState === "completed" ? "older-attempt" : "attempt-1" } } : { connected: true });
      }
      const { ticket } = await request.json();
      if (path.endsWith("/control")) return Response.json({ version: (await redeemHybragControl(f.env, ticket, "owner-proof")).version });
      await redeemHybragNoteTicket(f.env, ticket, "owner-proof");
      return Response.json({ accepted: true, knowledgeBaseId: "kb", knowledgeId: "doc", state: "pending", attempt: "attempt-1" }, { status: 202 });
    } });
    resources.push(() => target.stop(true));
    f.env.EDGE_EVER_HYBRAG_URL = `http://127.0.0.1:${target.port}`;
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("auth", { kind: "user", actorId: f.identity.userId, workspaceId: f.identity.workspaceId, sessionId: "session" }); await next(); });
    app.onError((error, c) => c.json({ error: { code: error.code } }, error.status || 500));
    registerHybragManualRoutes(app);
    const post = (route) => app.request(`/api/v1/integrations/hybrag/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rootId: "root", accessToken: "owner-proof" }) }, f.env);
    expect((await post("start")).status).toBe(200);
    expect((await post("step")).status).toBe(200);
    expect(await (await post("step")).json()).toEqual({ state: "recovery_required" });
    expect(f.database.query("SELECT pending_note_id, completed, last_error FROM hybrag_manual_runs").get())
      .toEqual({ pending_note_id: f.note.id, completed: 0, last_error: "hybrag_recovery_required" });
  });
  test("settings default closed, reject overlapping roots and stale updates", async () => {
    const f = await fixture();
    f.database.exec("DELETE FROM hybrag_settings");
    f.database.exec("DELETE FROM hybrag_control_events");
    f.database.exec("DELETE FROM hybrag_control_delivery");
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("auth", { kind: "user", actorId: f.identity.userId, workspaceId: f.identity.workspaceId, sessionId: "session" });
      await next();
    });
    registerHybragSettingsRoutes(app);
    const call = (method, body) => app.request("/api/v1/integrations/hybrag/settings", { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }, f.env);
    const initial = await (await call("GET")).json();
    expect(initial).toMatchObject({ enabled: false, roots: [], version: 0 });
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    // The application's normal error middleware maps AppError to its status.
    app.onError((error, context) => context.json({ code: error.code }, error.status || 500));
    expect((await call("PUT", { enabled: true, roots: ["root", "child"], version: 0 })).status).toBe(400);
    expect((await call("PUT", { enabled: true, roots: ["root"], version: 0 })).status).toBe(200);
    expect((await call("PUT", { enabled: false, roots: ["root"], version: 0 })).status).toBe(409);
    f.database.query("INSERT INTO hybrag_control_delivery(user_id,workspace_id,acknowledged_version) VALUES (?,?,1)").run(f.identity.userId, f.identity.workspaceId);
    expect((await f.redeem(await f.mint())).noteId).toBe(f.note.id);
  });
  test("upgrades the previous schema while preserving existing note content", async () => {
    const f = await fixture(true);
    const snapshot = await f.redeem(await f.mint());
    expect(snapshot.noteId).toBe(f.note.id);
    expect(snapshot.markdown).toBe("正文 with `a < b`");
  });
  test("exports only the selected descendant and consumes a hashed ticket exactly once", async () => {
    const f = await fixture();
    const ticket = await f.mint();
    const stored = f.database.query("SELECT * FROM hybrag_note_tickets").get();
    expect(JSON.stringify(stored)).not.toContain(ticket.token);
    const snapshot = await f.redeem(ticket);
    expect(snapshot).toMatchObject({ protocol: 1, subject: "owner-sub", workspaceId: f.identity.workspaceId, configVersion: 1, rootId: "root", rootName: "Root", noteId: f.note.id, notebookId: "child", title: "A title", markdown: "正文 with `a < b`" });
    await expect(f.redeem(ticket)).rejects.toMatchObject({ status: 404 });
  });

  test("another VOS subject cannot consume the ticket", async () => {
    const f = await fixture();
    const ticket = await f.mint();
    await expect(f.redeem(ticket, "other-proof")).rejects.toMatchObject({ status: 404 });
    expect((await f.redeem(ticket)).noteId).toBe(f.note.id);
  });

  test("a notebook move that makes selected roots overlap blocks issuance and redemption", async () => {
    const f = await fixture();
    f.database.query("UPDATE hybrag_settings SET roots_json = ?").run(JSON.stringify(["root", "outside"]));
    const ticket = await f.mint();
    f.database.query("UPDATE notebooks SET parent_id = 'root' WHERE id = 'outside'").run();
    await expect(f.mint()).rejects.toMatchObject({ status: 403 });
    await expect(f.redeem(ticket)).rejects.toMatchObject({ status: 409 });
  });

  for (const [name, sql] of [
    ["expired", "UPDATE hybrag_note_tickets SET expires_at = '2000-01-01T00:00:00.000Z'"],
    ["title changed", "UPDATE memos SET title = 'changed'"],
    ["body changed", "UPDATE memo_contents SET content_hash = 'changed', content_markdown = 'changed'"],
    ["moved outside", "UPDATE memos SET notebook_id = 'outside'"],
    ["deleted note", "UPDATE memos SET is_deleted = 1"],
    ["deleted root", "UPDATE notebooks SET is_deleted = 1 WHERE id = 'root'"],
    ["disabled owner", "UPDATE users SET is_disabled = 1"],
    ["revoked identity", "DELETE FROM user_identities WHERE provider = 'vos'"],
    ["revoked membership", "DELETE FROM workspace_members"],
    ["disabled integration", "UPDATE hybrag_settings SET enabled = 0, version = version + 1"],
    ["changed scope", "UPDATE hybrag_settings SET roots_json = '[]', version = version + 1"],
    ["workspace no longer personal", "UPDATE workspaces SET is_personal = 0"],
  ]) test(`rejects ${name} before exporting content`, async () => {
    const f = await fixture();
    const ticket = await f.mint();
    f.database.exec(sql);
    await expect(f.redeem(ticket)).rejects.toBeDefined();
    expect(f.database.query("SELECT consumed_at FROM hybrag_note_tickets").get().consumed_at).toBeNull();
  });

  test("rejects notes outside the root or containing embedded resources", async () => {
    const f = await fixture();
    const outside = await f.create("outside", "outside");
    await expect(mintHybragNoteTicket(f.env, f.identity, "root", outside.id)).rejects.toMatchObject({ status: 404 });
    for (const body of ["![image](https://example.com/a.png)", '<IMG src="x">', "[file](resource://id)", '<script src="x"></script>']) {
      const note = await f.create(body);
      await expect(mintHybragNoteTicket(f.env, f.identity, "root", note.id)).rejects.toMatchObject({ status: 422 });
    }
  });

  test("a concurrent double redemption returns the content only once", async () => {
    const f = await fixture();
    const ticket = await f.mint();
    const results = await Promise.allSettled([f.redeem(ticket), f.redeem(ticket)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  test("manual route forwards a one-use ticket server to server and cleans it up", async () => {
    const f = await fixture();
    let calls = 0;
    let busy = false;
    const target = Bun.serve({ port: 0, async fetch(request) {
      calls++;
      if (busy) return Response.json({ code: "vnote_busy", error: "private internal detail" }, { status: 409 });
      expect(request.headers.get("authorization")).toBe("Bearer owner-proof");
      const { ticket } = await request.json();
      const snapshot = await redeemHybragNoteTicket(f.env, ticket, "owner-proof");
      expect(snapshot.noteId).toBe(f.note.id);
      return Response.json({ accepted: true, knowledgeBaseId: "kb", knowledgeId: "doc", state: "pending" }, { status: 202 });
    } });
    resources.push(() => target.stop(true));
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("auth", { kind: "user", actorType: "user", actorId: f.identity.userId, workspaceId: f.identity.workspaceId, sessionId: "session", role: "owner", scopes: [] });
      await next();
    });
    app.onError((error, context) => context.json({ code: error.code }, error.status ?? 500));
    registerHybragNoteRoutes(app);
    const request = () => app.request("/api/v1/integrations/hybrag/sync-note", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: "owner-proof", rootId: "root", memoId: f.note.id }),
    }, { ...f.env, EDGE_EVER_HYBRAG_URL: `http://127.0.0.1:${target.port}` });
    const response = await request();
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ accepted: true, knowledgeBaseId: "kb", knowledgeId: "doc", state: "pending" });
    expect(calls).toBe(1);
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_note_tickets").get().n).toBe(0);
    busy = true;
    const waiting = await request();
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toEqual({ code: "hybrag_busy" });
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_note_tickets").get().n).toBe(0);
    target.stop(true);
    const failed = await request();
    expect(failed.status).toBe(503);
    expect(f.database.query("SELECT COUNT(*) AS n FROM hybrag_note_tickets").get().n).toBe(0);
  });
});
