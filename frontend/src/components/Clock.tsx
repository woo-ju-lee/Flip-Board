import { useEffect, useState } from "react";
import { formatTime } from "../format";

export function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="header-clock">
      <span>
        {new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Seoul",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .format(now)
          .replaceAll("-", ".")}
      </span>
      <strong>{formatTime(now.toISOString())}</strong>
      <small>KST · 서울</small>
    </div>
  );
}
