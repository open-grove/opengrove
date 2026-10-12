import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const directory = join(root, "test-results/shared-chat-ui-test");
await mkdir(directory, { recursive: true });
const modulePath = (name) => JSON.stringify(join(root, "web/src", name));
await writeFile(
  join(directory, "entry.tsx"),
  `
import {useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {ChatComposer} from ${modulePath("components/chat/chat-composer.tsx")};
import {MessageList} from ${modulePath("components/chat/message-list.tsx")};
import {QuestionInteractionCard} from ${modulePath("components/chat/message-activity.tsx")};
import {setLanguagePreference} from ${modulePath("i18n.ts")};
import ${modulePath("styles/tokens.css")};
import ${modulePath("styles/reset.css")};
import ${modulePath("components/chat/thread.css")};
const noop=()=>{};
function Fixture(){
 const [value,setValue]=useState(""),[running,setRunning]=useState(false),[messages,setMessages]=useState([]),[reply,setReply]=useState("");
 const [files,setFiles]=useState([]);
 const input=useRef(null),file=useRef(null),footer=useRef(null),composition=useRef(false);
 const submit=()=>{if(running){setRunning(false);return;}setMessages(current=>[...current,{id:String(current.length),role:"user",text:value}]);setValue("");setRunning(true);};
 return <main style={{maxWidth:800,margin:"40px auto",padding:20}}>
  <MessageList messages={messages} onResolveApproval={noop} onResolveQuestion={noop}/>
  <QuestionInteractionCard part={{
    id:"q-part",type:"tool",phase:"question",status:"pending",questionId:"q1",questionStatus:"pending",
    questionPrompt:"Choose files",questionInput:{method:"item/tool/requestUserInput",questions:[{
      id:"files",question:"Choose files",multiSelect:true,options:[{label:"one,two"},{label:"three"}]
    }]}
  }} onResolveQuestion={(id,action,response)=>setReply(JSON.stringify({id,action,response}))}/>
  <output aria-label="Product reply">{reply}</output>
  <ChatComposer sending={running} contextText="" attachments={files} contextArtifacts={[]}
    composerSkillInvocation={null} composerQuestionValue={value} composerHeight={96}
    model="gpt-5.4" activeKernel="codex" effort="medium" responseSpeed="standard" budgetLimitUsd={null}
    accessMode="default" modelMenuKind={null} modelMenuPlacement="up"
    planMode={false} goalMode={false} canShowPlanMode={false} canShowGoalMode={false}
    canShowReasoningControls={false} canShowSpeedControls={false} canShowBudgetControls={false} canGuideQueuedInstruction={false}
    composerInputRef={input} fileInputRef={file} modelMenuRef={footer}
    onQuestionChange={setValue} onSubmitOrStop={submit}
    onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey&&!composition.current){event.preventDefault();submit();}}}
    onPaste={noop} onCompositionStart={()=>{composition.current=true;}} onCompositionEnd={()=>{composition.current=false;}}
    onPointerDown={noop} onClearContext={noop} onRemoveContextArtifact={noop}
    onRemoveAttachment={id=>setFiles(current=>current.filter(item=>item.id!==id))}
    onAttachmentInputChange={event=>setFiles([...event.target.files].map(item=>({id:item.name,name:item.name,kind:"text",size:item.size,mediaType:item.type})))}
    onOpenAttachmentPicker={()=>file.current?.click()} onToggleModelMenu={noop}
    onTogglePlanMode={noop} onToggleGoalMode={noop} onGuideQueuedInstruction={noop}
    onRemoveQueuedInstruction={noop} onUpdateQueuedInstruction={noop} onMoveQueuedInstruction={noop}
    onSubmitQueuedInstructionNow={noop} onSetModel={noop} onSetEffort={noop}
    onSetResponseSpeed={noop} onSetBudgetLimitUsd={noop} onSetAccessMode={noop} onRemoveSkillInvocation={noop}
  />
  <button onClick={()=>setLanguagePreference("zh-CN")}>Chinese</button>
 </main>;
}
setLanguagePreference("en");
createRoot(document.getElementById("root")).render(<Fixture/>);
`,
);
await build({
  entryPoints: [join(directory, "entry.tsx")],
  outfile: join(directory, "app.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".woff2": "dataurl", ".woff": "dataurl" },
  logLevel: "error",
});
await writeFile(
  join(directory, "index.html"),
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./app.css"><div id="root"></div><script src="./app.js"></script>',
);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(join(directory, "index.html")).href);
  await page.getByRole("button", { name: "1. one,two" }).click();
  await page.getByRole("button", { name: "2. three" }).click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByLabel("Product reply")).toHaveText(
    '{"id":"q1","action":"answer","response":{"answers":{"files":{"answers":["one,two","three"]}}}}',
  );
  const input = page.locator("textarea.opengrove-question");
  await input.fill("中文草稿");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await expect(page.locator("article.role-user")).toHaveCount(0);
  await input.dispatchEvent("compositionend");
  await input.fill("A shared composer");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("article.role-user")).toContainText("A shared composer");
  await page.getByRole("button", { name: "Stop running", exact: true }).click();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("sample") });
  await expect(page.locator(".opengrove-composer")).toContainText("context.txt");
  await page.getByRole("button", { name: "Chinese", exact: true }).click();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
  await page.screenshot({ path: join(directory, "opengrove-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(directory, "opengrove-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("web-shared-chat-ui passed");
} finally {
  await browser.close();
}
