// The session list's Sort setting (docs/design-system.md, 3: Session list, and the select in 4:
// Inputs): a native select labelled "Sort", with the select icon drawn over its right edge.

import { useId } from 'react';
import { SORT_LABELS, SORT_ORDERS, type SortOrder } from '../sessions.js';
import { Icon } from './Icon.js';

export interface SortSelectProps {
  value: SortOrder;
  onChange: (order: SortOrder) => void;
}

export function SortSelect({ value, onChange }: SortSelectProps) {
  const id = useId();
  return (
    <div className="sort">
      <label className="sort-label" htmlFor={id}>
        Sort
      </label>
      <span className="select">
        <select
          id={id}
          className="select-input"
          value={value}
          onChange={(event) => {
            const chosen = SORT_ORDERS.find((order) => order === event.target.value);
            if (chosen) onChange(chosen);
          }}
        >
          {SORT_ORDERS.map((order) => (
            <option key={order} value={order}>
              {SORT_LABELS[order]}
            </option>
          ))}
        </select>
        <Icon name="select" className="select-icon" />
      </span>
    </div>
  );
}
