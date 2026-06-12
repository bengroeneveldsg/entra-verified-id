FROM public.ecr.aws/lambda/python:3.13

# CDK's Code.fromDockerBuild copies from /asset by default.
RUN pip install \
    cryptography==43.0.3 \
    lxml==5.3.0 \
    cffi==1.17.1 \
    aws-lambda-powertools==3.7.0 \
    --target /asset/python/lib/python3.13/site-packages \
    --no-compile \
    --upgrade \
    --quiet
