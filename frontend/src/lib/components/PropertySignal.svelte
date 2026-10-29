<script>
  import * as m from '$lib/paraglide/messages';
</script>

<!-- Shared Buried Signals property signature; synced by scripts/sync-property-signal.py. -->
<aside class="bs-property-signal" aria-label={m.propertySignal_network()}>
  <div class="bs-property-signal__content">
  <bs-property-radar class="bs-property-signal__radar" aria-hidden="true">
    <svg viewBox="0 0 400 200" fill="none" aria-hidden="true">
      <g stroke="currentColor" stroke-width="0.5" opacity="0.12">
        <circle cx="200" cy="200" r="60"/><circle cx="200" cy="200" r="120"/>
        <circle cx="200" cy="200" r="180"/><circle cx="200" cy="200" r="240"/>
      </g>
      <circle cx="200" cy="198" r="2.8" fill="#D4A853"/>
    </svg>
  </bs-property-radar>
  <a class="bs-property-signal__owner" href="https://buriedsignals.com/">Buried Signals</a>
  <nav class="bs-property-signal__switch" aria-label={m.propertySignal_format()}>
    <a href="/" aria-current="true"><span aria-hidden="true">◉</span> {m.propertySignal_human()}</a>
    <a href="/llms.txt" rel="alternate" type="text/plain"><span aria-hidden="true">○</span> {m.propertySignal_machine()}</a>
  </nav>
  </div>
</aside>
