// A radio group (docs/design-system.md, 4: Inputs, textareas and selects), W59: a <fieldset> named by
// its <legend>, holding a native <input type="radio"> for each option, each named by its <label> and
// described by its one plain line (aria-describedby). An optional hint under the legend describes the
// whole group, linked to the fieldset the same way.
//
// The radios are native, so the browser gives the group its keyboard: one Tab stop, the chosen
// option, and the arrow keys moving to the next or previous option and choosing it. A choice calls
// onChange at once: there's nothing to submit. The radios share a name of their own, from useId(),
// so two groups on one page, as in the gallery, never join.

import { useId, type ReactNode } from 'react';
import './RadioGroup.css';

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  /** One plain line under the label, saying what choosing it does. */
  description?: string;
}

export interface RadioGroupProps<T extends string> {
  /** The group's name, which a screen reader says once, before the option. */
  legend: string;
  /** Help text for the whole group, under the legend. */
  hint?: ReactNode;
  value: T;
  options: readonly RadioOption<T>[];
  /** Called with the option just chosen, never for the one already chosen. */
  onChange: (value: T) => void;
}

export function RadioGroup<T extends string>({ legend, hint, value, options, onChange }: RadioGroupProps<T>) {
  const id = useId();
  const hintId = `${id}hint`;
  return (
    <fieldset className="radio-group" aria-describedby={hint !== undefined ? hintId : undefined}>
      <legend className="radio-group-legend">{legend}</legend>
      {hint !== undefined && (
        <p className="field-hint radio-group-hint" id={hintId}>
          {hint}
        </p>
      )}
      <div className="radio-group-options">
        {options.map((option, index) => {
          const optionId = `${id}${index}`;
          const descriptionId = `${optionId}description`;
          return (
            <div key={option.value} className="radio-option">
              {/* Round, for the focus ring, which on the radio itself Chrome draws square (RadioGroup.css). */}
              <span className="radio-control">
                <input
                  id={optionId}
                  type="radio"
                  name={id}
                  value={option.value}
                  checked={option.value === value}
                  aria-describedby={option.description !== undefined ? descriptionId : undefined}
                  onChange={() => onChange(option.value)}
                />
              </span>
              <label htmlFor={optionId}>{option.label}</label>
              {option.description !== undefined && (
                <p className="radio-option-description" id={descriptionId}>
                  {option.description}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
