import { useI18n } from "../../i18n";
import { EmployeeAvatar } from "../ui/employee-avatar";
import { OpenGroveSaplingMark } from "../ui/opengrove-sapling-mark";

const AUTH_EMPLOYEE_NODES = [
  { id: "researcher", seed: "opengrove-auth-researcher:notionists:0:0" },
  { id: "editor", seed: "opengrove-auth-editor:notionists:0:1" },
  { id: "planner", seed: "opengrove-auth-planner:notionists:0:2" },
  { id: "designer", seed: "opengrove-auth-designer:notionists:0:3" },
  { id: "builder", seed: "opengrove-auth-builder:notionists:0:4" },
] as const;

export function CloudAuthConstellation() {
  const { t } = useI18n();

  return (
    <div className="cloud-auth-constellation" aria-hidden="true">
      <svg viewBox="0 0 760 440" preserveAspectRatio="xMidYMid meet">
        <path className="cloud-auth-orbit-line" d="M348 207C276 192 191 139 91 96" />
        <path className="cloud-auth-orbit-line is-faint" d="M354 198C331 155 296 105 258 70" />
        <path className="cloud-auth-orbit-line is-faint" d="M342 220C250 219 156 238 76 254" />
        <path className="cloud-auth-orbit-line" d="M343 218C305 214 278 211 251 209" />
        <path className="cloud-auth-orbit-line is-faint" d="M350 235C292 278 220 321 158 350" />
        <path className="cloud-auth-orbit-line is-cloud" d="M390 203C426 179 447 160 474 147" />
        <path className="cloud-auth-orbit-line is-cloud is-faint" d="M392 226C429 248 456 276 486 296" />
        <path className="cloud-auth-orbit-line is-cloud is-faint" d="M474 147L519 92L574 132" />
        <path className="cloud-auth-orbit-line is-cloud is-faint" d="M486 296L558 265L636 218" />

        <g className="cloud-auth-local-stars">
          <circle cx="39" cy="147" r="2.5" />
          <circle className="is-strong" cx="132" cy="39" r="3" />
          <circle cx="190" cy="117" r="4" />
          <circle className="is-strong" cx="289" cy="151" r="2.5" />
          <circle cx="112" cy="327" r="3.5" />
          <circle className="is-strong" cx="251" cy="334" r="2" />
          <circle cx="313" cy="286" r="3" />
          <circle cx="331" cy="190" r="3" />
          <circle className="is-strong" cx="402" cy="182" r="2.5" />
          <circle cx="409" cy="242" r="2" />
        </g>

        <g className="cloud-auth-cloud-signals">
          <g className="cloud-auth-cloud-signal is-secondary">
            <circle className="cloud-auth-signal-halo" cx="474" cy="147" r="6.5" />
            <circle className="cloud-auth-signal-core" cx="474" cy="147" r="2.3" />
          </g>
          <g className="cloud-auth-cloud-signal is-primary">
            <circle className="cloud-auth-signal-halo" cx="519" cy="92" r="8" />
            <circle className="cloud-auth-signal-core" cx="519" cy="92" r="3" />
          </g>
          <g className="cloud-auth-cloud-signal is-secondary">
            <circle className="cloud-auth-signal-halo" cx="486" cy="296" r="6" />
            <circle className="cloud-auth-signal-core" cx="486" cy="296" r="2.2" />
          </g>
          <g className="cloud-auth-cloud-signal is-primary">
            <circle className="cloud-auth-signal-halo" cx="636" cy="218" r="7.5" />
            <circle className="cloud-auth-signal-core" cx="636" cy="218" r="2.8" />
          </g>
        </g>

        <g className="cloud-auth-cloud-dust">
          <circle cx="574" cy="132" r="2.2" opacity="0.38" />
          <circle cx="632" cy="72" r="2.8" opacity="0.52" />
          <circle cx="690" cy="118" r="1.5" opacity="0.28" />
          <circle cx="724" cy="187" r="2.1" opacity="0.42" />
          <circle cx="558" cy="265" r="2.4" opacity="0.62" />
          <circle cx="532" cy="365" r="1.8" opacity="0.32" />
          <circle cx="612" cy="336" r="1.6" opacity="0.58" />
          <circle cx="685" cy="304" r="2.2" opacity="0.34" />
          <circle cx="728" cy="355" r="1.7" opacity="0.48" />
          <circle cx="452" cy="85" r="1.4" opacity="0.3" />
          <circle cx="589" cy="45" r="1.2" opacity="0.44" />
          <circle cx="721" cy="76" r="1.4" opacity="0.32" />
        </g>

        <g className="cloud-auth-cloud-more">
          <circle cx="731" cy="250" r="13" />
          <text x="731" y="254">
            +
          </text>
        </g>

        <g className="cloud-auth-cloud-caption" textAnchor="middle">
          <text className="cloud-auth-cloud-label" x="650" y="246">
            {t("auth.cloudAgents")}
          </text>
          <text className="cloud-auth-cloud-copy" x="650" y="262">
            {t("auth.cloudAgentsCopy")}
          </text>
        </g>
      </svg>

      {AUTH_EMPLOYEE_NODES.map((node) => (
        <span key={node.id} className={`cloud-auth-employee-node is-${node.id}`}>
          <EmployeeAvatar seed={node.seed} fallbackName={node.id} style={{ width: "100%", height: "100%" }} />
        </span>
      ))}

      <span className="cloud-auth-grove-node">
        <span className="cloud-auth-grove-mark">
          <OpenGroveSaplingMark />
        </span>
        <strong>{t("auth.brandName")}</strong>
      </span>
    </div>
  );
}
