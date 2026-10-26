import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Play, SlidersHorizontal, Square, Volume2, VolumeX } from "lucide-react";
import { flapAudio } from "../audio";

export function SoundControls({ reduced, onNotice }: { reduced: boolean; onNotice: (message: string) => void }) {
  const [state, setState] = useState(flapAudio.getState);
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const unsubscribe = flapAudio.subscribe(setState);
    return () => { unsubscribe(); flapAudio.mute(); };
  }, []);
  useEffect(() => { if (reduced) flapAudio.mute(); }, [reduced]);
  async function toggle() {
    try {
      const enabled = await flapAudio.toggle();
      setState(previous => ({ ...previous, enabled }));
      onNotice("");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "이 브라우저에서 소리를 재생할 수 없습니다.");
    }
  }
  async function preview() {
    try { await flapAudio.preview(); onNotice(""); }
    catch (error) { onNotice(error instanceof Error ? error.message : "소리를 재생할 수 없습니다."); }
  }
  return <div className="sound-controls">
    <button className={state.enabled ? "active-tool" : ""} onClick={toggle}
      disabled={reduced} aria-label={state.enabled ? "소리 끄기" : "소리 켜기"} aria-pressed={state.enabled}
      title={reduced ? "동작 줄이기 설정에서는 효과음이 꺼집니다" : state.enabled ? "소리 끄기" : "소리 켜기"}>
      {state.loading ? <LoaderCircle size={17} className="spin" /> : state.enabled ? <Volume2 size={17} /> : <VolumeX size={17} />}
    </button>
    <details ref={panel} className="sound-settings" onKeyDown={e => { if (e.key === "Escape" && panel.current) { panel.current.open = false; panel.current.querySelector("summary")?.focus(); } }}>
      <summary aria-label="사운드 설정" title="사운드 설정"><SlidersHorizontal size={16} /></summary>
      <div className="sound-panel" role="group" aria-label="플랩 사운드">
        <div className="sound-panel-heading"><strong>기계의 소리</strong><span>VESTABOARD</span></div>
        <label htmlFor="flap-volume">음량 <output>{Math.round(state.volume * 100)}%</output></label>
        <input id="flap-volume" type="range" min="0" max="100" step="1" value={Math.round(state.volume * 100)}
          aria-label="효과음 음량" onChange={e => flapAudio.setVolume(Number(e.target.value) / 100)} />
        <button className="preview-button" onClick={preview} disabled={reduced || state.loading || state.volume === 0}>
          {state.previewing ? <Square size={13} /> : <Play size={13} />}{state.previewing ? "미리듣기 정지" : "소리 미리듣기"}
        </button>
        <p>{reduced ? "동작 줄이기 설정으로 효과음이 꺼져 있습니다." : "판이 넘어가는 소리를 짧게 들어보세요."}</p>
        <a href="https://github.com/robonyong/react-split-flap-display#props" target="_blank" rel="noreferrer">Robin Yang · MIT</a>
      </div>
    </details>
  </div>;
}
