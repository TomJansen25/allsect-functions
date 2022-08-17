import { RichText } from 'prismic-dom'
const functions = require('firebase-functions')

const prismicSecret = functions.config().prismic.webhook_secret

export interface ThumbnailObject {
    dimensions: {
        width: number
        height: number
    }
    alt: string
    url: string
    copyright: string
}

export interface ImageObject extends ThumbnailObject {
    caption?: string
    thumbnail: ThumbnailObject
}

export interface FlattenedBody {
    texts: string
    images: Array<ImageObject>
}

export interface AlgoliaIndex {
    objectID: string
    uid: string
    lang: string
    subtitle: string
    title: string
    date: string
    text: string
    // images: Array<ImageObject>
}

export interface AlgoliaRecipeIndex extends AlgoliaIndex {
    introduction: string
    recipe_type: string
    insect_of_choice: string
}

export interface AlgoliaBlogPostIndex extends AlgoliaIndex {
    tl_dr: string
    tags: string
}

export function verifySecret(secret: string): boolean {

    if (secret === prismicSecret) {
        return true
    } else
        return false
}

function processLanguage(lang: string): string {
    switch (lang) {
        case "en-au":
        case "en-us": {
            return "en"
        }
        case "de-de": {
            return "de"
        }
        default: {
            return "en"
        }
    }
}

function flattenBody(body: Array<any>): FlattenedBody {
    const textArray: Array<string> = []
    const imageArray: Array<ImageObject> = []

    body.forEach((slice: any) => {
        switch (slice.slice_type) {
            case 'text':
            case 'quote': {
                textArray.push(RichText.asText(slice.primary.text))
                break
            }
            case 'image_with_caption':
            case 'image': {
                imageArray.push(slice.primary.image)
                break
            }
            default: {
                break

            }
        }
    })

    return { texts: textArray.join(' '), images: imageArray }
}

export function processRecipe(doc: any): AlgoliaRecipeIndex {

    const title = RichText.asText(doc.data.title)
    const subtitle = RichText.asText(doc.data.subtitle)
    const intro = RichText.asText(doc.data.introduction)
    const ingredients = RichText.asText(doc.data.ingredients)
    const prep = RichText.asText(doc.data.prep)
    const main_image = doc.data.main_image
    const { texts } = flattenBody(doc.data.body)

    const algoliaIndex = {
        objectID: doc.id,
        uid: doc.uid,
        lang: processLanguage(doc.lang),
        title: title,
        subtitle: subtitle,
        date: doc.data.date,
        introduction: intro,
        recipe_type: doc.data.recipe_type,
        insect_of_choice: doc.data.insect_of_choice,
        ingredients: ingredients,
        main_image: main_image,
        prep: prep,
        text: texts,
        // images: images
    }

    return algoliaIndex
}


export function processBlogPost(doc: any): AlgoliaBlogPostIndex {

    const title = RichText.asText(doc.data.title)
    const subtitle = RichText.asText(doc.data.subtitle)
    const main_image = doc.data.main_image
    const { texts } = flattenBody(doc.data.body)

    const algoliaIndex = {
        objectID: doc.id,
        uid: doc.uid,
        lang: processLanguage(doc.lang),
        title: title,
        subtitle: subtitle,
        date: doc.data.date,
        tl_dr: doc.data.tl_dr,
        tags: doc.data.tags,
        main_image: main_image,
        text: texts,
        // images: images
    }

    return algoliaIndex
}
