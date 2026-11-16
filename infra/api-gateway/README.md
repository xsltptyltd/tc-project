# api-gateway (REST)

Placeholder. Will hold the backendless read API for messages missed while the websocket was
closed: API Gateway → VTL → DynamoDB `Query`, no Lambda in the integration, a Lambda
authorizer in front.

`templates/messages/` is where the VTL request/response templates will go.
