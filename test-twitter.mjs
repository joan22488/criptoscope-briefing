import "dotenv/config";

// Bearer token público que usa la web de X
const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I%2BAUYnzpFSvF8J%2BX5uiZ%2BqTfHo0s8%2Fo4DBUKMYqEAAAAA";
const AUTH_TOKEN = "5ab874b3b920e9c1f4455585122c912033b861ac";
const CT0 = "2aa4dd998a0568e6d09521f117ac91e1b5bb32b2f55a3ca339984d3581145b0ede45f068dea8e151444b8578402454fd296f45230ffd609570e7fc231aff4b3c44335728dfaba4e2a316be32de45ca8b";

// Primero obtenemos el userId de @saylor
const userRes = await fetch(
  `https://api.x.com/graphql/oUZZZ8Oddwxs8Cd3iW3UEA/UserByScreenName?variables=${encodeURIComponent(JSON.stringify({screen_name:"saylor",withSafetyModeUserFields:true}))}&features=${encodeURIComponent(JSON.stringify({hidden_profile_subscriptions_enabled:true,rweb_tipjar_consumption_enabled:true,responsive_web_graphql_exclude_directive_enabled:true,verified_phone_label_enabled:false,highlights_tweets_tab_ui_enabled:true,creator_subscriptions_tweet_preview_api_enabled:true,responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,responsive_web_graphql_timeline_navigation_enabled:true}))}`,
  {
    headers: {
      "Authorization": `Bearer ${BEARER}`,
      "Cookie": `auth_token=${AUTH_TOKEN}; ct0=${CT0}`,
      "x-csrf-token": CT0,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
    }
  }
);
console.log("Status:", userRes.status);
const data = await userRes.json();
console.log("Response:", JSON.stringify(data).slice(0, 400));
