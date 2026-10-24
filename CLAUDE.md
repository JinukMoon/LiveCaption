# 64_listening_app — LiveCaption

실시간 영어 STT + 한국어 번역 폰 웹앱 (2026-10-24~). 사용 설명은 `README.md`.

- **배포**: 이 폴더가 곧 repo `JinukMoon/LiveCaption` (`main` 루트 → GitHub Pages
  https://jinukmoon.github.io/LiveCaption/). 빌드 없음, 파일 고치고 push하면 끝.
- **범위**: 사용자 지시로 기능은 "들리는 영어 → 실시간 텍스트 → 한국어 번역"만. 말하기 피드백·TTS·요약 같은
  학습 기능은 넣지 않는다(2026-10-24). 실전 사용성이 최우선.
- **사용 기기**: 폰만(아이폰). Zoom도 노트북 스피커 옆에 폰을 두는 방식. 시스템 오디오 캡처는 필요 없음.
- **커밋**: 작성자·Co-Authored-By에 Claude 넣지 않는다.

## 키 (repo에 절대 넣지 말 것)

- 원본: `/home/jumoon/99_usefull/11_English/API-Key` (ElevenLabs, Gemini 두 줄 구조). 앱은 브라우저 localStorage에만 저장.
- 설정 링크 + QR은 `private/`(gitignore)에 만든다.
- 이 ElevenLabs 키는 **speech_to_text 권한만** 있다(TTS·user_read는 401). 앱엔 충분.
- Gemini 키는 2026-10-24 기준 **선불 크레딧 소진(402)** → 앱은 자동으로 Google 번역(gtx, 키 없음)으로 대체.
  충전되면 저절로 Gemini로 돌아온다(10분 쿨다운 후 재시도).

## Scribe v2 Realtime 실측 메모 (2026-10-24)

- 브라우저에서 `POST /v1/single-use-token/realtime_scribe`(xi-api-key) 직접 호출 가능(CORS `*`). 토큰 15분 유효, 접속에만 씀.
- WS 파라미터: `commit_strategy=vad`, `vad_silence_threshold_secs=0.8`, `language_code=en`, `keyterms` 반복 파라미터.
- **keyterms는 하나라도 20자 넘으면 세션 전체가 `invalid_request`로 닫힌다** → 앱에서 20자 이하·50개로 거른다.
- `previous_text`는 세션 첫 chunk에만 허용(재연결 때 직전 문장 꼬리 50자를 넣는다).
- 쉬지 않고 길게 말하면(강의) VAD 커밋이 15초 넘게 안 옴 → 앱이 부분 자막 안의 문장 끝(. ? !, 약어 제외)을
  **뒤에 5단어가 더 붙어 안정되면** 문장 단위로 확정·번역한다(`live.done` = 이미 넘긴 단어 수, 커밋 때 그만큼 잘라냄).
  Scribe는 부분 자막의 끝 몇 토큰(`max_tokens_to_recompute: 5`)만 고쳐 쓰므로 그 앞은 안정적이다.
  남은 미완성 문장은 8단어 이상·5단어 증가·1.5초 간격으로 미리 번역(회색).
- `language_code=en`이어도 한국어 발화는 한국어로 받아 적는다 → 한글이 한 글자라도 있으면 번역 생략.
- **세션 길이**: 35분 연속 스트리밍 실측에서 서버가 **19.1분에 오류 없이 정상 종료(code 1000)**. 토큰 15분 만료는
  열린 세션에 영향 없음. → 앱은 세션이 15분을 넘으면 다음 커밋 직후(말이 끊긴 순간) 새 세션으로 갈아탄다
  (`ROLLOVER_MS`, 테스트는 `ROLLOVER_MS=20000` 환경변수로 20초마다). 갈아탈 때 문장이 쪼개지지 않음을 확인.
- **침묵**: 1분 완전 무음 + 1분 잡음(-60 dBFS)에도 세션 유지, 다시 말하면 즉시 인식. 침묵 중엔 약 35초마다
  빈 committed_transcript가 오며 앱은 무시한다. 침묵 시간도 과금된다.

## 테스트

```bash
. <키 export 스크립트>   # EL_KEY, GM_KEY
~/miniconda3/envs/toolkit/bin/python tests/e2e.py tests/test.wav 75
```
`tests/*.wav`(gitignore)는 16 kHz mono 아무 음성이면 된다. `test.wav` = 46_Listening TED 클립 13초 +
15_english_paper_writing 5차시 강의 50초(한국어 섞임), `lecture.wav` = TED `jM5MIRDCL-8` 120–230초
(쉬지 않는 강연, 문장 단위 끊기 확인용). 결과 스크린샷·로그는 `tests/out/`. 30초에 테스트가 소켓을 일부러 끊는다.
실기기(아이폰 Safari/홈 화면 앱)의 마이크 끊김·Wake Lock 동작은 이 테스트로 못 본다 — 실제 폰에서 확인.
