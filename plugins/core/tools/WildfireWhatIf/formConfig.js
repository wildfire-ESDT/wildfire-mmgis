// Panel form schema, mirroring WorkflowsTool's ENDPOINTS pattern: fields are
// declared as data and rendered generically by <SchemaForm/>. Field shape:
//   key         store key the field reads/writes
//   label       optional label row (with the type tag, like Workflows)
//   type        'date' | 'number' | 'text' | 'select'
//   var         tool variable (Configure page) that seeds the default
//   min/max     number bounds
//   suffix      static text rendered after the input (e.g. ':00 PDT')
//   options     select choices [{value, label}]
//   required    submit blocks when empty…
//   errorKey    …and this store flag drives the error styling
//   description hint line under the input
const FORM_SECTIONS = [
    {
        title: 'Simulation Type',
        fields: [
            {
                key: 'simType',
                type: 'select',
                options: [
                    { value: 'fire_spread', label: 'Fire Spread' },
                    { value: 'smoke_dispersion', label: 'Smoke Dispersion' },
                ],
            },
        ],
    },
    {
        title: 'Scenario Name',
        fields: [
            {
                key: 'runName',
                type: 'text',
                placeholder: 'e.g. Palisades – SE wind shift',
                required: true,
                errorKey: 'nameError',
            },
        ],
    },
]

// Store patch seeding schema defaults from the tool's Configure-page variables.
export function seedFromVars(vars) {
    const patch = {}
    FORM_SECTIONS.forEach((section) =>
        section.fields.forEach((f) => {
            if (f.var && vars[f.var] != null && vars[f.var] !== '')
                patch[f.key] =
                    f.type === 'number' ? Number(vars[f.var]) : vars[f.var]
        })
    )
    return patch
}

export default FORM_SECTIONS
