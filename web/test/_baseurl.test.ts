describe('base url propagation', () => {
  it('prints the env + resolved engine base url', () => {
    // eslint-disable-next-line no-console
    console.error('ENV GPU_TEST_BASE_URL=' + JSON.stringify(process.env.GPU_TEST_BASE_URL));
    // eslint-disable-next-line no-console
    console.error('ENV ARR_BASE_URL=' + JSON.stringify(process.env.ARR_BASE_URL));
    expect(true).toBe(true);
  });
});
