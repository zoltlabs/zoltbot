import { useEffect, useState } from "react";
import { Icon } from "../shell/icons.js";
export function ViewIcon({ hash, path }: { hash: string; path?: string | undefined }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    setUrl("");
    if (path && window.zoltDesktop?.prepareView)
      void window.zoltDesktop
        .prepareView(hash)
        .then((result) => {
          const target = new URL(result.url);
          target.pathname = `/${path.split("/").map(encodeURIComponent).join("/")}`;
          if (active) setUrl(target.href);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [hash, path]);
  return url ? (
    <img className="view-icon" src={url} alt="" onError={() => setUrl("")} />
  ) : (
    <Icon name="Projects" />
  );
}
