import { Layout } from '../layout';
import { todayInTz } from '../../lib/dates';
import type { Client, Invoice, InvoiceItem, Settings } from '../../db/queries';

export type InvoiceFormProps = {
  currentPath: string;
  clients: Client[];
  settings: Settings;
  /** Next auto number, shown as an editable prefill on new invoices. */
  suggestedNumber?: string;
  invoice?: Invoice;
  items?: InvoiceItem[];
  errors?: string[];
  /** Values to re-populate the form with after a failed submit (overrides `invoice`/`items` when set). */
  formValues?: {
    number?: string;
    client_id?: string;
    issue_date?: string;
    due_date?: string;
    subject?: string;
    notes?: string;
    item_description?: string[];
    item_quantity?: string[];
    item_unit_price?: string[];
  };
};


/** Effective default rate for a client as a "150.00" input value, or '' when none. */
function effectiveRate(client: Client, settings: Settings): string {
  const cents = client.default_rate_cents ?? settings.default_rate_cents;
  return cents > 0 ? (cents / 100).toFixed(2) : '';
}

/** Effective payment terms (days) for a client, or '' when none. */
function effectiveTerms(client: Client, settings: Settings): string {
  const days = client.payment_terms_days ?? settings.payment_terms_days;
  return days > 0 ? String(days) : '';
}

export function InvoiceFormPage(props: InvoiceFormProps) {
  const { currentPath, clients, settings, invoice, errors } = props;
  const isEdit = !!invoice;
  const title = isEdit ? `Edit invoice ${invoice!.number}` : 'New invoice';
  const actionUrl = isEdit ? `/admin/invoices/${invoice!.id}/edit` : '/admin/invoices/new';

  if (!isEdit && clients.length === 0) {
    return (
      <Layout title={title} currentPath={currentPath}>
        <div class="page-head">
          <h1 class="page-title">New invoice</h1>
        </div>
        <div class="banner banner-error">
          You need at least one client before you can create an invoice.{' '}
          <a href="/admin/clients/new">Add a client</a>.
        </div>
      </Layout>
    );
  }

  const fv = props.formValues;
  const selectedClientId = fv?.client_id ?? (invoice ? String(invoice.client_id) : '');
  const issueDate = fv?.issue_date ?? invoice?.issue_date ?? todayInTz(settings.timezone);
  const dueDate = fv?.due_date ?? invoice?.due_date ?? '';
  const subject = fv?.subject ?? invoice?.subject ?? '';
  const notes = fv?.notes ?? invoice?.notes ?? '';

  const itemDescriptions = fv?.item_description ?? props.items?.map((it) => it.description) ?? [];
  const itemQuantities = fv?.item_quantity ?? props.items?.map((it) => String(it.quantity)) ?? [];
  const itemUnitPrices =
    fv?.item_unit_price ?? props.items?.map((it) => (it.unit_price_cents / 100).toFixed(2)) ?? [];

  const rowCount = Math.max(1, itemDescriptions.length);
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    description: itemDescriptions[i] ?? '',
    quantity: itemQuantities[i] ?? '1',
    unit_price: itemUnitPrices[i] ?? '',
  }));

  return (
    <Layout title={title} currentPath={currentPath}>
      <div class="page-head">
        <h1 class="page-title">{title}</h1>
      </div>

      {errors?.length ? (
        <div class="banner banner-error">
          {errors.length === 1 ? (
            errors[0]
          ) : (
            <>
              <strong>Fix these before saving:</strong>
              <ul class="warning-list">
                {errors.map((e) => (
                  <li>{e}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      <div class="card">
        <form method="post" action={actionUrl}>
          {!isEdit ? (
            <div class="form-row">
              <div class="form-group">
                <label for="number">Invoice number</label>
                <input
                  type="text"
                  id="number"
                  name="number"
                  value={fv?.number ?? props.suggestedNumber ?? ''}
                />
                <span class="muted">Edit for a custom number, or leave as-is to use the counter.</span>
              </div>
            </div>
          ) : null}

          <div class="form-row">
            <div class="form-group">
              <label for="client_id">Client</label>
              <select id="client_id" name="client_id" required>
                <option value="" disabled selected={!selectedClientId}>
                  Select a client
                </option>
                {clients.map((client) => (
                  <option
                    value={String(client.id)}
                    data-rate={effectiveRate(client, settings)}
                    data-terms={effectiveTerms(client, settings)}
                    selected={selectedClientId === String(client.id)}
                  >
                    {client.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="issue_date">Issue date</label>
              <input type="date" id="issue_date" name="issue_date" value={issueDate} required />
            </div>
            <div class="form-group">
              <label for="due_date">Due date</label>
              <input type="date" id="due_date" name="due_date" value={dueDate} />
            </div>
          </div>

          <div class="form-group">
            <label for="subject">Subject</label>
            <input
              type="text"
              id="subject"
              name="subject"
              value={subject}
              placeholder="e.g. Website redesign — July"
            />
            <span class="muted">
              Optional. Shows on the invoice, in the email subject, and on the dashboard.
            </span>
          </div>

          <div class="form-group">
            <label for="notes">Notes</label>
            <textarea id="notes" name="notes">
              {notes}
            </textarea>
          </div>

          <table class="items-editor" id="items-editor">
            <thead>
              <tr>
                <th>Description</th>
                <th>Quantity</th>
                <th>Unit price</th>
                <th class="text-right">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="items-editor-body">
              {rows.map((row) => (
                <tr class="item-row">
                  <td>
                    <textarea name="item_description[]" class="item-desc" rows={1}>
                      {row.description}
                    </textarea>
                  </td>
                  <td>
                    <input type="number" step="any" name="item_quantity[]" value={row.quantity} class="item-qty" />
                  </td>
                  <td>
                    <input type="text" name="item_unit_price[]" value={row.unit_price} class="item-price" />
                  </td>
                  <td class="text-right item-amount">—</td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-secondary item-remove"
                      aria-label="Remove line"
                      title="Remove line"
                      hidden={rows.length === 1}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colspan={3} class="text-right subtotal-label">
                  Subtotal
                </td>
                <td class="text-right item-amount" id="items-subtotal">
                  —
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>

          <div class="mt-2">
            <button type="button" class="btn btn-secondary btn-sm" id="add-line-btn">
              + Add line
            </button>
            <span class="muted" id="rate-hint-wrap" style="margin-left: 12px" hidden>
              Default unit price: <span id="rate-hint"></span>
            </span>
          </div>

          <div class="actions mt-2">
            <button type="submit" class="btn btn-primary">
              {isEdit ? 'Save changes' : 'Create invoice'}
            </button>
            {isEdit ? (
              <a class="btn btn-secondary" href={`/admin/invoices/${invoice!.id}`}>
                Cancel
              </a>
            ) : (
              <a class="btn btn-secondary" href="/admin">
                Cancel
              </a>
            )}
          </div>
        </form>
      </div>

      <template id="item-row-template">
        <tr class="item-row">
          <td>
            <textarea name="item_description[]" class="item-desc" rows={1}></textarea>
          </td>
          <td>
            <input type="number" step="any" name="item_quantity[]" value="1" class="item-qty" />
          </td>
          <td>
            <input type="text" name="item_unit_price[]" value="" class="item-price" />
          </td>
          <td class="text-right item-amount">—</td>
          <td>
            <button type="button" class="btn btn-secondary item-remove" aria-label="Remove line" title="Remove line">
              ×
            </button>
          </td>
        </tr>
      </template>

      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  var body = document.getElementById('items-editor-body');
  var template = document.getElementById('item-row-template');
  var addBtn = document.getElementById('add-line-btn');
  var clientSelect = document.getElementById('client_id');

  function currentRate() {
    var opt = clientSelect.options[clientSelect.selectedIndex];
    return (opt && opt.getAttribute('data-rate')) || '';
  }

  var issueInput = document.getElementById('issue_date');
  var dueInput = document.getElementById('due_date');
  var dueTouched = dueInput.value !== '';
  dueInput.addEventListener('input', function () { dueTouched = dueInput.value !== ''; });

  // Prefill due = issue + terms while the admin hasn't set one explicitly
  function applyTerms() {
    var opt = clientSelect.options[clientSelect.selectedIndex];
    var days = opt ? parseInt(opt.getAttribute('data-terms') || '', 10) : NaN;
    if (dueTouched || !issueInput.value || !isFinite(days) || days <= 0) return;
    var d = new Date(issueInput.value + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    dueInput.value = d.toISOString().slice(0, 10);
  }

  issueInput.addEventListener('change', applyTerms);

  function updateRateHint() {
    var rate = currentRate();
    var wrap = document.getElementById('rate-hint-wrap');
    wrap.hidden = !rate;
    if (rate) document.getElementById('rate-hint').textContent = rate;
  }

  // Fill empty price fields with the selected client's default rate.
  function applyRate() {
    var rate = currentRate();
    if (!rate) return;
    Array.prototype.forEach.call(body.querySelectorAll('.item-price'), function (input) {
      if (input.value.trim() === '') {
        input.value = rate;
        input.dispatchEvent(new Event('input'));
      }
    });
  }

  clientSelect.addEventListener('change', function () {
    applyRate();
    updateRateHint();
    applyTerms();
  });

  function formatAmount(qty, price) {
    var q = parseFloat(qty);
    var p = parseFloat(price);
    if (!isFinite(q) || !isFinite(p)) return '—';
    return (q * p).toFixed(2);
  }

  // Running subtotal over all valid rows (invalid/blank rows contribute nothing)
  function updateSubtotal() {
    var sum = 0;
    var any = false;
    body.querySelectorAll('.item-row').forEach(function (row) {
      var q = parseFloat(row.querySelector('.item-qty').value);
      var p = parseFloat(row.querySelector('.item-price').value);
      if (isFinite(q) && isFinite(p)) { sum += q * p; any = true; }
    });
    document.getElementById('items-subtotal').textContent = any ? sum.toFixed(2) : '—';
  }

  // Grow description boxes with their content (single-line height at rest)
  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function wireRow(row) {
    var qty = row.querySelector('.item-qty');
    var price = row.querySelector('.item-price');
    var amount = row.querySelector('.item-amount');
    var removeBtn = row.querySelector('.item-remove');
    var desc = row.querySelector('.item-desc');

    desc.addEventListener('input', function () { autosize(desc); });
    autosize(desc);

    function update() {
      amount.textContent = formatAmount(qty.value, price.value);
      updateSubtotal();
    }
    qty.addEventListener('input', update);
    price.addEventListener('input', update);
    update();

    removeBtn.addEventListener('click', function () {
      if (body.querySelectorAll('.item-row').length > 1) {
        row.remove();
      }
      updateRemoveButtons();
      updateSubtotal();
    });
  }

  // The last remaining line can't be removed — hide its button entirely
  function updateRemoveButtons() {
    var rows = body.querySelectorAll('.item-row');
    rows.forEach(function (r) {
      r.querySelector('.item-remove').hidden = rows.length <= 1;
    });
  }

  Array.prototype.forEach.call(body.querySelectorAll('.item-row'), wireRow);

  addBtn.addEventListener('click', function () {
    var clone = template.content.cloneNode(true);
    body.appendChild(clone);
    var row = body.querySelector('.item-row:last-child');
    wireRow(row);
    var price = row.querySelector('.item-price');
    var rate = currentRate();
    if (rate && price.value.trim() === '') {
      price.value = rate;
      price.dispatchEvent(new Event('input'));
    }
    updateRemoveButtons();
  });

  applyRate();
  updateRateHint();
  applyTerms();
  updateRemoveButtons();

  // --- Inline validation: same rules as the server, caught before submit.
  // setCustomValidity + reportValidity = native focus, bubbles, a11y.
  var form = document.querySelector('form[action*="/invoices/"]');
  // We orchestrate validation ourselves: otherwise stale customValidity from a
  // previous attempt blocks requestSubmit BEFORE our handler can clear it.
  form.noValidate = true;

  function validAmount(v) {
    // NB: this lives inside a TSX template literal — regex backslashes must be
    // double-escaped or JS eats them and the pattern matches literal letters.
    var c = v.replace(/[$,\\s]/g, '');
    return c !== '' && c !== '.' && /^\\d*\\.?\\d{1,10}$/.test(c) && isFinite(parseFloat(c));
  }

  function clearField(el) {
    if (el && el.setCustomValidity) { el.setCustomValidity(''); el.classList.remove('field-invalid'); }
  }

  form.addEventListener('submit', function (e) {
    // Fresh slate every attempt — no stale errors can linger
    form.querySelectorAll('input, select, textarea').forEach(clearField);
    var bad = [];
    var touchedRows = 0;
    var firstDesc = null;
    body.querySelectorAll('.item-row').forEach(function (row) {
      var d = row.querySelector('[name="item_description[]"]');
      var p = row.querySelector('.item-price');
      var q = row.querySelector('.item-qty');
      if (!firstDesc) firstDesc = d;
      [d, p, q].forEach(clearField);
      var touched = d.value.trim() !== '' || p.value.trim() !== '';
      if (!touched) return;
      touchedRows++;
      if (d.value.trim() === '') { d.setCustomValidity('Description is required for this line.'); bad.push(d); }
      if (p.value.trim() === '') { p.setCustomValidity('Unit price is required.'); bad.push(p); }
      else if (!validAmount(p.value)) { p.setCustomValidity('"' + p.value + '" is not a valid amount.'); bad.push(p); }
      var qv = q.value.trim() === '' ? 1 : parseFloat(q.value);
      if (!(qv > 0)) { q.setCustomValidity('Quantity must be a positive number.'); bad.push(q); }
    });
    if (touchedRows === 0 && firstDesc) {
      firstDesc.setCustomValidity('Add at least one line item.');
      bad.push(firstDesc);
    }
    var due = document.getElementById('due_date');
    clearField(due);
    if (due.value && issueInput.value && due.value < issueInput.value) {
      due.setCustomValidity('Due date is before the issue date (' + issueInput.value + ').');
      bad.push(due);
    }
    if (bad.length || !form.checkValidity()) {
      e.preventDefault();
      bad.forEach(function (el) { el.classList.add('field-invalid'); });
      form.reportValidity(); // focuses the first invalid field and shows its message
    }
  });

  // Fixing a field clears its error immediately
  form.addEventListener('input', function (ev) { clearField(ev.target); });
})();
`,
        }}
      ></script>
    </Layout>
  );
}
