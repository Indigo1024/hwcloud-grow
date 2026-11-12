#!/usr/bin/env node
/** 每日核对：积分明细 + 任务面板点亮，两号都查 */
import { chromium } from "playwright";
import { resolveAuthFile } from "./auth-utils.mjs";
import { GrowApi, shanghaiDate, isTodayShanghai } from "./grow-api.mjs";
import { resolveAccountId } from "./accounts.mjs";

const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const b = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-features=NetworkChangeNotifier","--no-first-run"] });
const ctx = await b.newContext({ storageState: resolveAuthFile(ACCOUNT_ID), locale: "zh-CN" });
const api = new GrowApi(ctx);
const today = shanghaiDate().replace(/\//g, "-");
console.log(`\n===== ${ACCOUNT_ID} ${today} =====`);
const flows = (await api.bonusFlow(20).catch(() => [])) || [];
flows.filter((f) => isTodayShanghai(f.time)).forEach((f) => console.log(`  ${f.time} +${f.points} ${f.source}`));
const r = (await api.myMissions().catch(() => null)) || {};
(r.missions || []).filter((m) => /每日|每周实践|每周Star|每周给/.test(m.title)).forEach((m) => console.log(`  ${m.isFinish ? "✅" : "❌"} +${m.bonus} ${m.title}`));
await api.close(); await b.close();
