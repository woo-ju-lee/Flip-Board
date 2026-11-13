import App from "./App";
import { serviceDemoRequest } from "./serviceDemoRequest";

export default function ServiceDemo() {
  return <App request={serviceDemoRequest} initialSource="archive" initialMode="station"
    timetableDemo homeHref="?demo=services" />;
}
