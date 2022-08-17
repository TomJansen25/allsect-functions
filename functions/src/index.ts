const functions = require('firebase-functions')

import admin = require('firebase-admin')
admin.initializeApp(functions.config().firebase)
const db = admin.firestore()

//const firestore = require('@google-cloud/firestore');
//const client = new firestore.v1.FirestoreAdminClient();

const runtimeOpts = {
    timeoutSeconds: 360,
    memory: '256MB',
}

const NewsAPI = require('newsapi')
const newsapi = new NewsAPI(functions.config().newsapi.key)

const sgMail = require('@sendgrid/mail')
sgMail.setApiKey(functions.config().sendgrid.key)

const Prismic = require('prismic-javascript')
const prismicAPI = functions.config().prismic.api
const prismicAccessToken = functions.config().prismic.access_token

const algoliasearch = require('algoliasearch');
const algoliaClient = algoliasearch(functions.config().algolia.app_id, functions.config().algolia.api_key);

const { PubSub } = require('@google-cloud/pubsub')
const pubSubClient = new PubSub()

const path = require('path');
const os = require('os');
const fs = require('fs');

import { EventContext, Request, Response } from 'firebase-functions'
import { CallableContext } from 'firebase-functions/lib/providers/https'
import { Message } from 'firebase-functions/lib/providers/pubsub'
import { processRecipe, processBlogPost, AlgoliaRecipeIndex, AlgoliaBlogPostIndex, AlgoliaIndex, verifySecret } from './prismic-functions'

export interface NewsApiResponseArticle {
    source: {
        id: string | null
        name: string
    }
    author: string
    title: string
    description: string
    url: string
    urlToImage: string
    publishedAt: string
    content: string
}

export interface NewsApiResponse {
    status: string
    totalResults: number
    articles: NewsApiResponseArticle[]
}

export interface FirestoreNewsArticle {
    authors: string[]
    content: string
    description: string
    publishedAt: admin.firestore.Timestamp
    source: string
    title: string
    url: string
    urlToImage: string
}

export interface PubsSubNewsArticles {
    id: string
    title: string
    url: string
}

export interface NewComment {
    username: string
    text: string
    dateCreated: Date
    blogPostId?: string
    recipeId?: string
}

export interface PostCommentData {
    username: string
    text: string
    postType: string
    postId: string
}

async function publishMessage(topicName: string, caller: string, data: any) {

    console.log(JSON.stringify(data))

    const dataBuffer = Buffer.from(JSON.stringify(data))
    const customAttributes = {
        origin: caller,
        date: new Date().toDateString(),
    }

    const messageId = await pubSubClient
        .topic(topicName)
        .publish(dataBuffer, customAttributes)

    console.log(`Message ${messageId} published.`)
}

/**
 * Firebase scheduled function that runs every Monday and Thursday at 8PM to get the latest news articles
 */
exports.getLatestNews = functions.region('europe-west3')
    .runWith(runtimeOpts)
    .pubsub.schedule('0 20 * * MON,THU')
    .timeZone('Europe/Berlin')
    .onRun(
        (context: EventContext): Promise<any> => {

            const day = new Date(Date.now() - 3 * 86400000)
            const from_date = day.toISOString().split('T')[0]

            return newsapi.v2
                .everything({
                    q: 'entomophagy OR "edible insects"',
                    from: from_date,
                    language: 'en',
                    sortBy: 'relevancy',
                })
                .then((res: NewsApiResponse) => {
                    // const news_articles: PubsSubNewsArticles[] = []

                    if (res.totalResults > 0) {

                        res.articles.map((article: NewsApiResponseArticle) => {
                            try {
                                let authors: string[] = []

                                if (article.author) {
                                    authors = article.author.split(',')
                                }

                                const news_article_data: FirestoreNewsArticle = {
                                    authors: authors,
                                    content: article.content,
                                    description: article.description,
                                    publishedAt: admin.firestore.Timestamp.fromDate(
                                        new Date(article.publishedAt)
                                    ),
                                    source: article.source.name,
                                    title: article.title,
                                    url: article.url,
                                    urlToImage: article.urlToImage,
                                }

                                db.collection('news_articles')
                                    .add(news_article_data)
                                    .then((ref) => {
                                        console.log(
                                            'Added document with ID: ',
                                            ref.id
                                        )

                                        const email_data = {
                                            id: ref.id,
                                            title: news_article_data.title,
                                            url: news_article_data.url,
                                            source: news_article_data.source
                                        }

                                        publishMessage(
                                            'email-latest-news',
                                            'getLatestNews Firebase function',
                                            email_data
                                        ).catch(console.error)
                                    })
                                    .catch((err) => {
                                        console.error(err)
                                    })
                            } catch (error) {
                                console.log(
                                    'article could not be processed due to: ',
                                    error
                                )
                            }
                        })
                        console.log('Articles found and added to Firestore')
                    } else {
                        console.log(
                            'No news articles published in the last days were found'
                        )
                    }
                })
        }
    )

/**
 * Function that is triggered by Pubsub messages if news articles are retrieved to send emails with key information about the news article(s) retrieved
 */
exports.emailLatestNews = functions.region('europe-west3').runWith(runtimeOpts).pubsub.topic('email-latest-news').onPublish(
    (message: Message, context: EventContext): Promise<any> => {

        const buffered_message = Buffer.from(message.data, 'base64').toString();

        console.log(JSON.parse(buffered_message))

        const msg = {
            to: 'info@allsect.com',
            from: 'tomjansen25@gmail.com',
            templateId: 'd-05fba0835eeb473dae475067401860bd',
            dynamic_template_data: JSON.parse(buffered_message),
        }

        return sgMail.send(msg)
    }
)

/**
 * Function triggered by Prismic if a new document is published to insert Index based on document in Algolia Search Engine
 */
exports.prismicWebhook = functions.region('europe-west3').https.onRequest((request: Request, response: Response) => {

    if (verifySecret(request.body.secret) === false) {
        response.status(400).send('Prismic Request Secret is invalid, function is not further processed.')
    }

    const latestRef: string = request.body.masterRef
    console.log('Current Prismic ref: ', latestRef)

    Prismic.api(prismicAPI, { accessToken: prismicAccessToken, req: request }).then(function (api: any) {
        const options = {
            ref: latestRef,
            lang: 'en-au',
            orderings: '[document.last_publication_date desc]',
            pageSize: 1,
            page: 1
        }

        return api.query('', options)

    }).then(function (res: any) {
        const document = res.results[0]
        console.log('Processing newly published document: ' + document.uid)

        let processedDocument: AlgoliaIndex | AlgoliaRecipeIndex | AlgoliaBlogPostIndex = {} as AlgoliaIndex;
        let index;

        if (document.type === 'post') {
            console.log('Prismic document is a blog post')
            processedDocument = processBlogPost(document)
            index = algoliaClient.initIndex('BlogPosts')

        } else if (document.type === 'recipe') {
            console.log('Prismic document is a recipe')
            processedDocument = processRecipe(document)
            index = algoliaClient.initIndex('Recipes')

        } else {
            response.status(400).send('Prismic document type unknown and could not be processed.')
        }

        index.partialUpdateObject(processedDocument, {
            createIfNotExists: true,
        }).then(() => {
            console.log('Index ' + processedDocument.objectID + ' for article ' + processedDocument.title + ' added to Algolia');
        }).catch((err: any) => {
            console.log(err);
        });


    }).catch((err: any) => {
        console.log('Something went wrong: ', err)
    });

    response.send('Prismic Webhook Function successfully finished processing')
})

/**
 * Function called upon by the Website if a new comment is published to save the comment in Cloud Firestore collection 'comments'
 */
exports.postComment = functions.region('us-central1').https.onCall(async (data: PostCommentData, context: CallableContext) => {

    console.log(data)

    const newComment: NewComment = {
        username: data.username,
        text: data.text,
        dateCreated: new Date(),
    }

    if (data.postType === 'blogPost') {
        newComment.blogPostId = data.postId
    } else if (data.postType === 'recipe') {
        newComment.recipeId = data.postId
    }

    await db.collection('comments').add(newComment);
})


/**
 * Firebase scheduled to function that runs every Sunday at 8PM to backup Firestore database to GCP Bucket
 */
exports.backupFirestore = functions.region('europe-west3').pubsub.schedule('0 20 * * SUN').timeZone('Europe/Berlin').onRun(async (context: EventContext): Promise<any> => {

    const collections = await db.listCollections()
    const collectionIds: string[] = collections.map(col => col.id)
    console.log({ collections: collectionIds })

    const allCollections: any = {}

    for (const collectionId of collectionIds) {
        console.log(collectionId)

        const currentCollection: any = {}
        const colSnapshot = await db.collection(collectionId).get()

        colSnapshot.forEach(doc => {
            currentCollection[doc.id] = doc.data()
        });

        allCollections[collectionId] = currentCollection
    }

    const now = new Date()
    const datestamp = now.toISOString().replace(/-/g, '').replace(/:/g, '').split('.')[0]

    const filename = `backup_${datestamp}.txt`;
    console.log(filename)

    const tempLocalFile = path.join(os.tmpdir(), filename);
    console.log(tempLocalFile)

    return new Promise((resolve, reject) => {
        fs.writeFile(tempLocalFile, JSON.stringify(allCollections), (error: any) => {
            if (error) {
                reject(error);
                return;
            }
            const bucket = admin.storage().bucket();
            console.log(bucket.name)

            bucket
                .upload(tempLocalFile, {
                    destination: `backups/${filename}`,
                    gzip: true,
                    metadata: {
                        cacheControl: 'public, max-age=31536000',
                    },
                })
                .then(response => {
                    console.log(`Firestore collections backed up successfully to file "backups/${filename}".`)
                    resolve(response)
                })
                .catch(err => {
                    console.log('Firestore collections backed up went wrong...')
                    reject(err)
                });
        });
    });
})
