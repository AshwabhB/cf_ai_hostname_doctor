// The ASCII (Punycode) form under an internationalized name. An all-Cyrillic lookalike
// passes the mixed-script check, so the user can still see it is not the Latin name it
// resembles.
export function AsciiName({
  ascii,
  display
}: {
  ascii: string;
  display: string;
}) {
  if (!ascii || ascii === display) return null;
  return (
    <span
      className="block truncate font-mono text-xs text-kumo-subtle"
      title={ascii}
    >
      {ascii}
    </span>
  );
}
