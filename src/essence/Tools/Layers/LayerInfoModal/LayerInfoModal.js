import $ from 'jquery'
import L_ from '../../../Basics/Layers_/Layers_'
import Modal from '../../../Basics/UserInterface_/components/Modal/Modal'
import showdown from 'showdown'

import './LayerInfoModal.css'

showdown.setFlavor('github')

const LayerInfo = {
    converter: new showdown.Converter(),
    open: function (layerName) {
        console.log('LayerInfo.open called with:', layerName)
        let layer = L_.layers.data[layerName]
        
        // If not found by name, try to find by UUID
        if (layer == null) {
            console.log('Layer not found by name, searching by UUID...')
            console.log('Available layers:', Object.keys(L_.layers.data))
            for (const name in L_.layers.data) {
                console.log('Checking layer:', name, 'UUID:', L_.layers.data[name].uuid)
                if (L_.layers.data[name].uuid === layerName) {
                    layer = L_.layers.data[name]
                    console.log('Found layer by UUID:', name)
                    break
                }
            }
        }

        if (layer == null) {
            console.log('Layer not found for:', layerName)
            return
        }

        let numberOfFeatures = ''
        if (layer.type === 'vector')
            try {
                numberOfFeatures = ` ${
                    L_.layers.layer[layerName].getLayers().length
                } Features`
            } catch (e) {}

        let type = layer.type
        if (type === 'tile') type = 'raster'

        // Description may have been fetched from CMR during layer initialization
        let description = layer.description || ''
        
        // Remove image references from markdown to prevent 404 errors
        if (description) {
            description = description.replace(/!\[.*?\]\(.*?\)/g, '')
        }

        // prettier-ignore
        Modal.set(
            [
                `<div id='LayerInfoModal'>`,
                    `<div id='LayerInfoModalTitle' style='background: var(--color-${layer.type});'>`,
                        `<div><i class='mdi mdi-information-outline mdi-18px'></i><div>Information</div></div>`,
                        `<div id='LayerInfoModalClose'><i class='mmgisHoverBlue mdi mdi-close mdi-18px'></i></div>`,
                    `</div>`,
                    `<div id='LayerInfoModalContent'>`,
                        `<div id='LayerInfoModalInnerTitle'>${layer.display_name}</div>`,
                        `<div id='LayerInfoModalInnerSubtitle'>${type}<span>${numberOfFeatures}</span></div>`,

                            layer.tags && layer.tags.length > 0 ?
                                [
                                    `<div id='LayerInfoModalTags'>`,
                                        `<div id='LayerInfoModalTagsContent'>`,
                                            layer.tags.map((tag) => {
                                                if( typeof tag === 'string' && tag.length > 0) {
                                                    let catname, tagname
                                                    if( tag.indexOf(':') > -1)
                                                        [catname, ...tagname] = tag.split(":");
                                                    else tagname = tag

                                                    return [
                                                        `<div class='LayerInfoModalTag'>`,
                                                            catname != null ? `<div class='LayerInfoModalTagCat'>${catname}</div>` : '',
                                                            `<div class='LayerInfoModalTagName'>${tagname}</div>`,
                                                        `</div>`
                                                    ].join('\n')
                                                }
                                            }).join('\n'),
                                        `</div>`,
                                    `</div>`
                                ].join('\n') : '',

                        `<div id='LayerInfoModalDescription'>`,
                            `<div id='LayerInfoModalDescriptionContent'>`,
                                description ? LayerInfo.converter.makeHtml(description) : '<div class="LayerInfoModalNone">No Description</div>',
                            `</div>`,
                        `</div>`,
                        `<div id='LayerInfoModalInnerUUID'>${layer.uuid}</div>`,
                    `</div>`,
                `</div>`
            ].join('\n'),
            function () {
                $('#LayerInfoModalClose').on('click', function () {
                    Modal.remove()
                })
            }
        )
    },
}

export default LayerInfo
