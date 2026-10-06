// The DNS records a customer must add for one hostname. Shared by the tools and the
// STATE block so the model always gives the same, correct instructions.
import { getDomain } from "tldts";
import { TXT_PREFIX } from "./service";

export type RequiredRecords = {
  apex: boolean;
  txt: { type: "TXT"; name: string; value: string };
  routing: {
    type: "CNAME" | "ALIAS or flattened CNAME";
    name: string;
    value: string;
    note: string;
  };
};

export function requiredRecords(
  hostname: string,
  token: string,
  fallbackOrigin: string
): RequiredRecords {
  // A registrable domain (an apex) cannot hold a plain CNAME.
  const apex = getDomain(hostname, { allowPrivateDomains: true }) === hostname;
  return {
    apex,
    txt: { type: "TXT", name: `${TXT_PREFIX}.${hostname}`, value: token },
    routing: apex
      ? {
          type: "ALIAS or flattened CNAME",
          name: hostname,
          value: fallbackOrigin,
          note: "This is an apex domain, so a plain CNAME is not allowed. Use CNAME flattening or an ALIAS record. The TXT record alone proves ownership."
        }
      : {
          type: "CNAME",
          name: hostname,
          value: fallbackOrigin,
          note: "Routes traffic. The TXT record alone proves ownership."
        }
  };
}
