import ktx from "../assets/train-logos/ktx.svg";
import sancheon from "../assets/train-logos/ktx-sancheon.svg";
import cheongryong from "../assets/train-logos/ktx-cheongryong.png";
import cheongchun from "../assets/train-logos/itx-cheongchun.svg";
import itxSaemaeul from "../assets/train-logos/itx-saemaeul.svg";
import saemaeul from "../assets/train-logos/saemaeul.svg";
import mugunghwa from "../assets/train-logos/mugunghwa.svg";
import nuriro from "../assets/train-logos/nuriro.svg";
import { FlapPanel } from "./FlapPanel";

const TRAIN_KINDS = Object.freeze([
  "KTX", "KTX-산천", "KTX-이음", "KTX-청룡", "ITX-새마을", "ITX-청춘",
  "ITX-마음", "새마을", "무궁화", "누리로",
]);
const logos: Record<string, { src: string; subtitle?: string }> = {
  KTX: { src: ktx }, "KTX-산천": { src: sancheon }, "KTX-이음": { src: ktx, subtitle: "이음" },
  "KTX-청룡": { src: cheongryong }, "ITX-청춘": { src: cheongchun }, "ITX-새마을": { src: itxSaemaeul },
  새마을: { src: saemaeul }, 무궁화: { src: mugunghwa }, 누리로: { src: nuriro },
};
function renderLogo(kind: string) {
  const logo = logos[kind];
  return <span className={`train-logo-art ${logo?.subtitle ? "train-logo-with-subtitle" : ""}`}>
    {logo ? <img className="train-logo-image" src={logo.src} alt="" draggable={false} /> : <span className="train-logo-label">{kind}</span>}
    {logo?.subtitle && <span className="train-logo-subtitle">{logo.subtitle}</span>}
  </span>;
}

export function TrainLogo({ kind, index, reduced }: { kind: string; index: number; reduced: boolean }) {
  return <span className="train-logo" aria-label={kind || "빈칸"} title={kind}>
    <FlapPanel value={kind} labels={TRAIN_KINDS} index={index} reduced={reduced} renderValue={renderLogo} className="logo-leaf" />
  </span>;
}
