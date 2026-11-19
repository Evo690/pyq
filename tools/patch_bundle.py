#!/usr/bin/env python3
"""Apply source-level fixes to the checked-in minified application bundle.

The repository ships a prebuilt React bundle, while the smaller feature modules
are plain ESM. This script records every replacement made to that bundle so a
future rebuild can reproduce the behavior. It is safe to run repeatedly.
"""

from __future__ import annotations

from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[1] / "assets" / "index-ff8d0e4d.js"

REPLACEMENTS = [
    (
        "imports",
        "readWorkspaceStore",
        r'''import{ExactPaperPicker}from"./exact-paper.mjs";import{TestAnalysisScreen}from"./test-analysis.mjs";import{dataJson,pickQuestions,topicInsights,topicPerformance,adaptivePracticeQuestions,dueReviewEntries,dueReviewCount,scheduleReview,analyzeTest,requestExamFullscreen,releaseExamFullscreen}from"./experience.mjs";''',
        r'''import{ExactPaperPicker,compactExactPaperTest,restoreExactPaperTest,restoreExactPaperSession}from"./exact-paper.mjs";import{OfflineCacheManager}from"./offline-ui.mjs";import{readWorkspaceStore,workspaceSaver}from"./offline-storage.mjs";import{TestAnalysisScreen}from"./test-analysis.mjs";import{dataJson,pickQuestions,topicInsights,topicPerformance,adaptivePracticeQuestions,dueReviewEntries,dueReviewCount,scheduleReview,analyzeTest,requestExamFullscreen,releaseExamFullscreen,isScoreableQuestion,isCorrectAnswer}from"./experience.mjs";''',
    ),
    (
        "reliable-store-load",
        "function gp(){return readWorkspaceStore(O3)}",
        r'''function gp(){try{return{...O3,...JSON.parse(localStorage.getItem("pyq-studio-v1")||"{}")}}catch{return O3}}''',
        r'''function gp(){return readWorkspaceStore(O3)}''',
    ),
    (
        "reliable-store-save",
        "workspaceSaver.schedule(G)",
        r'''Ae.useEffect(()=>{try{localStorage.setItem("pyq-studio-v1",JSON.stringify(G))}catch{X("Storage is full. Export your progress from settings to keep a backup.")}},[G])''',
        r'''Ae.useEffect(()=>{try{workspaceSaver.schedule(G)}catch{X("Storage is full. Export your progress from settings to keep a backup.")}},[G]),Ae.useEffect(()=>{const storageError=e=>X(e?.detail?.message||"Storage is full. Export your progress from settings to keep a backup.");return window.addEventListener("pyq:storage-error",storageError),()=>window.removeEventListener("pyq:storage-error",storageError)},[])''',
    ),
    (
        "settings-offline-manager",
        "f.jsx(OfflineCacheManager,{React:Ae,notify:r})",
        r'''f.jsxs("div",{className:"source-note",children:[f.jsx(eu,{size:20})''',
        r'''f.jsx(OfflineCacheManager,{React:Ae,notify:r}),f.jsxs("div",{className:"source-note",children:[f.jsx(eu,{size:20})''',
    ),
    (
        "offline-source-note",
        "download a paper for offline use",
        r'''Some diagrams load from the source CDN and need internet access.''',
        r'''Diagrams load from the source CDN; download a paper for offline use to keep them with you.''',
    ),
    (
        "rich-html-sanitizer",
        'ADD_TAGS:["use","mjx-container"]',
        r'''ADD_ATTR:["target"],FORBID_TAGS:["style","iframe"],FORBID_ATTR:["srcset"]});''',
        r'''ADD_TAGS:["use","mjx-container"],ADD_ATTR:["target","href","xlink:href","jax","overflow","display","data-mjx-texclass","data-mml-node","data-c","data-variant","data-frame-styles","data-orsrc","data-line","data-frame","data-mjx-viewbox","data-mjx-linebox","data-mjx-lineno","data-mjx-linestack","data-mjx-error","data-background","data-padding"],ALLOW_DATA_ATTR:!0,FORBID_TAGS:["style","iframe"],FORBID_ATTR:["srcset"]});''',
    ),
    (
        "allow-blob-image-src",
        "{ALLOWED_URI_REGEXP:/^(?:(?:blob|https?",
        r'''let s=yp.sanitize(String(i),{ADD_TAGS:''',
        r'''let s=yp.sanitize(String(i),{ALLOWED_URI_REGEXP:/^(?:(?:blob|https?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,ADD_TAGS:''',
    ),
    (
        "shared-scoring",
        "const Xr=i=>isScoreableQuestion(i)",
        r'''const Xr=i=>i.type!=="multipleCorrect"&&(i.type==="numerical"?Number.isFinite(Number(i.correct_answer)):(i.options||[]).some(n=>String(n.id)===String(i.correct_answer)));function Cf(i,n){return!Xr(i)||n==null||n===""?!1:i.type==="numerical"?Number.isFinite(Number(n))&&Math.abs(Number(n)-Number(i.correct_answer))<1e-6:String(n)===String(i.correct_answer)}''',
        r'''const Xr=i=>isScoreableQuestion(i);function Cf(i,n){return isCorrectAnswer(i,n)}''',
    ),
    (
        "session-source",
        "paperSource=R.find",
        r'''const id=String(Date.now()),deadline=re==="test"?Date.now()+Number(He)*6e4:null,session={questions:R,title:ue,mode:re,minutes:Number(He),id,exam:o,deadline,exactPaper:!!exactPaper,answers:{},marks:{},questionTimes:{},currentIndex:0};''',
        r'''const id=String(Date.now()),paperSource=R.find(q=>q.paperSource)?.paperSource||null,deadline=re==="test"?Date.now()+Number(He)*6e4:null,session={questions:R,title:ue,mode:re,minutes:Number(He),id,exam:o,deadline,exactPaper:!!exactPaper,exactPaperSource:paperSource,answers:{},marks:{},questionTimes:{},currentIndex:0};''',
    ),
    (
        "saved-session-source",
        "activeSession:{id,exam:o,title:ue,minutes:Number(He),deadline,exactPaper:!!exactPaper,exactPaperSource:paperSource",
        r'''activeSession:{id,exam:o,title:ue,minutes:Number(He),deadline,exactPaper:!!exactPaper,questionRefs:R.map(q=>({uid:q.uid,question_id:q.question_id,subject:q.subject,chapter:q.chapter})),answers:{},marks:{},questionTimes:{},currentIndex:0,updatedAt:new Date().toISOString()}''',
        r'''activeSession:{id,exam:o,title:ue,minutes:Number(He),deadline,exactPaper:!!exactPaper,exactPaperSource:paperSource,questionRefs:R.map(q=>({uid:q.uid,question_id:q.question_id,subject:q.subject,chapter:q.chapter,type:q.type,paperPosition:q.paperPosition})),answers:{},marks:{},questionTimes:{},currentIndex:0,updatedAt:new Date().toISOString()}''',
    ),
    (
        "resume-archive-session",
        "restoreExactPaperSession(draft)",
        r'''const refs=draft.questionRefs||[],questions=await loadQuestionRefs(draft.exam,refs,i);''',
        r'''const refs=draft.questionRefs||[],questions=draft.exactPaperSource?await restoreExactPaperSession(draft):await loadQuestionRefs(draft.exam,refs,i);''',
    ),
    (
        "open-archive-report",
        "let reportRecord=R",
        r'''openTestReport=R=>{setSelectedTest(R),setReportOrigin(p),b("testReport"),ie(!1),window.scrollTo(0,0)}''',
        r'''openTestReport=async R=>{let reportRecord=R;if(R?.exactPaperSource){setRestoreLoading(!0);try{reportRecord=await restoreExactPaperTest(R)}catch(restoreError){X(restoreError.message||"The exact paper could not be reopened.");setRestoreLoading(!1);return}setRestoreLoading(!1)}setSelectedTest(reportRecord),setReportOrigin(p),b("testReport"),ie(!1),window.scrollTo(0,0)}''',
    ),
    (
        "persist-compact-report",
        "const persisted=compactExactPaperTest(R)",
        r'''onComplete:R=>{$((ue)=>({...ue,tests:[R,...ue.tests],activeSession:null})),releaseExamFullscreen(),ve(null),setSelectedTest(R),setReportOrigin("tests"),b("testReport"),window.scrollTo(0,0)}''',
        r'''onComplete:R=>{const persisted=compactExactPaperTest(R);$((ue)=>({...ue,tests:[persisted,...ue.tests],activeSession:null})),releaseExamFullscreen(),ve(null),setSelectedTest(R),setReportOrigin("tests"),b("testReport"),window.scrollTo(0,0)}''',
    ),
    (
        "review-archive-report",
        "restoreExactPaperTest(test).then",
        r'''onReview:test=>rt(test.questions,test.title,"review")''',
        r'''onReview:test=>restoreExactPaperTest(test).then(R=>rt(R.questions,R.title,"review")).catch(restoreError=>X(restoreError.message||"The exact paper could not be reopened."))''',
    ),
    (
        "submit-unscored-items",
        "if(!Xr(ge)){unscored++",
        r'''i.questions.forEach(ge=>{const Me=Z[ge.uid];if(Me===void 0||Me===""){_e++,r(ge,void 0,null);return}if(ge.type==="multipleCorrect"){unscored++,r(ge,Me,null);return}const Nt=Cf(ge,Me);Nt?ae++:Ee++,r(ge,Me,Nt)});''',
        r'''i.questions.forEach(ge=>{const Me=Z[ge.uid];if(Me===void 0||Me===""){if(!Xr(ge)){unscored++,r(ge,Me,null);return}_e++,r(ge,void 0,null);return}if(!Xr(ge)){unscored++,r(ge,Me,null);return}const Nt=Cf(ge,Me);Nt?ae++:Ee++,r(ge,Me,Nt)});''',
    ),
    (
        "report-source-metadata",
        "exam:i.exam,exactPaperSource:",
        r'''const Le={id:String(Date.now()),date:new Date().toISOString(),exam:i.exam,title:i.title,minutes:i.minutes,''',
        r'''const Le={id:String(Date.now()),date:new Date().toISOString(),exam:i.exam,exactPaperSource:i.exactPaperSource||null,title:i.title,minutes:i.minutes,''',
    ),
    (
        "report-question-correctness",
        '||!Xr(ge)?null:Cf(ge,Z[ge.uid])',
        r'''isCorrect:Z[ge.uid]===void 0||Z[ge.uid]===""||ge.type==="multipleCorrect"?null:Cf(ge,Z[ge.uid])''',
        r'''isCorrect:Z[ge.uid]===void 0||Z[ge.uid]===""||!Xr(ge)?null:Cf(ge,Z[ge.uid])''',
    ),
    (
        "practice-unscored-check",
        "Xr(pe)?Cf(pe,De):null",
        r'''Ot=()=>{L(Z=>({...Z,[pe.uid]:!0})),r(pe,De,Cf(pe,De))}''',
        r'''Ot=()=>{L(Z=>({...Z,[pe.uid]:!0})),r(pe,De,Xr(pe)?Cf(pe,De):null)}''',
    ),
    (
        "hide-missing-difficulty",
        "pe.difficulty_level!=null",
        r'''f.jsxs("span",{children:["Level ",pe.difficulty_level]})''',
        r'''pe.difficulty_level!=null&&pe.difficulty_level!==""&&f.jsxs("span",{children:["Level ",pe.difficulty_level]})''',
    ),
    (
        "dropped-question-note",
        "pe.bonus?",
        r'''pe.type==="multipleCorrect"&&f.jsxs("p",{className:"data-note",children:[f.jsx(H3,{size:17}),"This source may have an incomplete multi-answer key. Use the solution to review; this question is not automatically scored."]})''',
        r'''pe.type==="multipleCorrect"&&f.jsxs("p",{className:"data-note",children:[f.jsx(H3,{size:17}),pe.bonus?"This question was dropped in the original paper; all options were accepted. It is included for review but left unscored.":"This source may have an incomplete multi-answer key. Use the solution to review; this question is not automatically scored."]})''',
    ),
    (
        "numerical-bonus-note",
        'pe.answerRule?.kind==="bonus"',
        r'''pe.type==="numerical"?f.jsxs("div",{className:"numerical-answer",''',
        r'''pe.type==="numerical"&&pe.answerRule?.kind==="bonus"&&f.jsx("p",{className:"data-note",children:"This numerical question was a bonus in the original paper. It is included for review but left unscored; see the worked solution for the accepted key."}),pe.type==="numerical"?f.jsxs("div",{className:"numerical-answer",''',
    ),
]


def _expected_variants(index: int, new: str) -> list[str]:
    variants = [new]
    for _, _, later_old, later_new in REPLACEMENTS[index + 1 :]:
        if later_old in variants[-1]:
            variants.append(variants[-1].replace(later_old, later_new, 1))
    return variants


def main() -> None:
    source = BUNDLE.read_text(encoding="utf-8")
    applied = []
    for index, (name, marker, old, new) in enumerate(REPLACEMENTS):
        if marker in source:
            if any(variant in source for variant in _expected_variants(index, new)):
                continue
            raise RuntimeError(f"{name}: patch appears partially applied")
        count = source.count(old)
        if count != 1:
            raise RuntimeError(f"{name}: expected one match, found {count}")
        source = source.replace(old, new, 1)
        applied.append(name)
    if applied:
        BUNDLE.write_text(source, encoding="utf-8")
    print(f"Patched {len(applied)} bundle locations: {', '.join(applied) or 'none'}")


if __name__ == "__main__":
    main()
