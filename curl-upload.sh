curl --request POST \
  --url http://localhost:3000/upload \
  --header 'Authorization: test' \
  --header 'Expect:' \
  --form accessKeyId=00b66ba6d4b4a863ab91a2b9a46e6128 \
  --form secretAccessKey=fb07b3d813668852a0e5a35f9602b07eb5d90cbbf74dad20c4fd1bfd887e6d1f \
  --form endpoint=https://e8f92de6cd6146ff2ea89925c7cb5575.r2.cloudflarestorage.com \
  --form bucket=rabbitholes-apps \
  --form file=@/Users/praneethpike/Work/Rabbitholes/artifacts/v5.0.0-beta.6/rabbitholes-app-5.0.0-beta.6-x64.dmg
